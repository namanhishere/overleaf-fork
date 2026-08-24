import OError from "@overleaf/o-error";
import { ProjectRelease } from "../../models/ProjectRelease.mjs";
import { CompileJob } from "../../models/CompileJob.mjs";
import AuditLogManager from "../Audit/AuditLogManager.mjs";

const TAG_RE = /^v?\d+(\.\d+){0,2}([-+].*)?$/i;

/**
 * Resolve the build a release should pin. An explicit buildId wins;
 * otherwise the most recent successful compile job of the project is used
 * so "tag what just compiled" is a single click.
 */
async function resolveBuild(projectId, buildId) {
  if (buildId != null && buildId !== "") {
    return { buildId: String(buildId), jobId: null };
  }
  const job = await CompileJob.findOne({ projectId, status: "success" })
    .sort({ queuedAt: -1 })
    .lean()
    .exec();
  if (job == null || job.buildId == null) {
    throw new OError("no successful compile to release", { projectId });
  }
  return { buildId: job.buildId, jobId: job.jobId };
}

async function createRelease(
  projectId,
  { tag, notes = "", buildId = null, version = null, userId = null },
) {
  const cleanTag = String(tag || "").trim();
  if (!TAG_RE.test(cleanTag)) {
    throw new OError("invalid release tag", { tag: cleanTag });
  }
  const resolved = await resolveBuild(projectId, buildId);
  // Record the source revision (PLANS 4/7 traceability): when no explicit
  // version is supplied, pin the release to the current project-history
  // version (startVersion + number of changes).
  let resolvedVersion = version != null ? Number(version) : null;
  if (resolvedVersion == null) {
    try {
      const HistoryManager = (await import("../History/HistoryManager.mjs"))
        .default;
      const chunk = await HistoryManager.promises.getLatestHistory(projectId);
      resolvedVersion =
        (chunk.chunk?.startVersion ?? 0) +
        (chunk.chunk?.history?.changes?.length ?? 0);
    } catch {
      // history unavailable: release without a version link (diff will 409)
    }
  }
  const job = resolved.jobId
    ? await CompileJob.findOne({ jobId: resolved.jobId }).lean().exec()
    : await CompileJob.findOne({ projectId, buildId: resolved.buildId })
        .sort({ queuedAt: -1 })
        .lean()
        .exec();
  try {
    const release = await ProjectRelease.create({
      projectId,
      tag: cleanTag,
      version: resolvedVersion,
      buildId: resolved.buildId,
      jobId: resolved.jobId,
      imageName: job?.imageName ?? null,
      compiler: job?.compiler ?? null,
      notes: String(notes).slice(0, 2000),
      createdBy: userId,
    });
    await AuditLogManager.promises.recordAudit({
      actorId: userId,
      action: "release-created",
      targetType: "project",
      targetId: String(projectId),
      projectId,
      info: {
        tag: cleanTag,
        buildId: resolved.buildId,
        version: release.version,
      },
    });
    return release.toObject ? release.toObject() : release;
  } catch (err) {
    if (err?.code === 11000) {
      throw new OError("duplicate release tag", { tag: cleanTag });
    }
    throw err;
  }
}

async function listReleases(projectId, { limit = 50, offset = 0 } = {}) {
  const [releases, total] = await Promise.all([
    ProjectRelease.find({ projectId })
      .sort({ createdAt: -1 })
      .skip(Math.max(offset, 0))
      .limit(Math.min(limit, 100))
      .lean()
      .exec(),
    ProjectRelease.countDocuments({ projectId }),
  ]);
  return { releases, total, limit, offset };
}

async function getRelease(projectId, releaseId) {
  return ProjectRelease.findOne({ _id: releaseId, projectId }).lean().exec();
}

// Diff a release's source (via its linked project-history version)
// against the current documents (PLANS 7 "Diff"). Returns per-file hunk
// diffs; files only in one side are reported as fully added/removed.
async function diffReleaseAgainstCurrent(projectId, releaseId) {
  const release = await getRelease(projectId, releaseId);
  if (release == null) {
    const err = new Error("release not found");
    err.statusCode = 404;
    throw err;
  }
  if (release.version == null) {
    const err = new Error("release has no linked history version");
    err.statusCode = 409;
    throw err;
  }
  const HistoryManager = (await import("../History/HistoryManager.mjs"))
    .default;
  const snapshot = await HistoryManager.promises.getContentAtVersion(
    projectId,
    release.version,
  );
  const ProjectEntityHandler = (
    await import("../Project/ProjectEntityHandler.mjs")
  ).default;
  const ProjectGetter = (await import("../Project/ProjectGetter.mjs")).default;
  const project = await ProjectGetter.promises.getProject(projectId, {
    rootFolder: 1,
  });
  const currentDocs = new Map();
  const find = (folder, base) => {
    for (const doc of folder.docs || []) {
      currentDocs.set(base + doc.name, doc);
    }
    for (const child of folder.folders || []) {
      find(child, `${base}${child.name}/`);
    }
  };
  for (const root of project.rootFolder || []) find(root, "");

  const LineDiff = (await import("../../infrastructure/LineDiff.mjs")).default;
  const files = [];
  const snapshotPaths = new Set();
  // history-v1 returns files as a {path: {content}} map (or an array in
  // some versions) - normalize to entries.
  const snapshotEntries = Array.isArray(snapshot.files)
    ? snapshot.files.map((f) => [f.path, f])
    : Object.entries(snapshot.files || {});
  for (const [entryPath, entry] of snapshotEntries) {
    const entryContent = entry.content ?? entry;
    snapshotPaths.add(entryPath);
    const oldLines = Array.isArray(entryContent?.lines)
      ? entryContent.lines
      : String(entryContent ?? "").split("\n");
    const doc = currentDocs.get(entryPath);
    let newLines = [];
    if (doc != null) {
      const fetched = await ProjectEntityHandler.promises.getDoc(
        projectId,
        doc._id,
      );
      newLines = fetched.lines || [];
    }
    const hunks = LineDiff.computeHunks(oldLines, newLines);
    files.push({
      path: entryPath,
      status:
        doc == null
          ? "removed-since-release"
          : hunks.length === 0
            ? "unchanged"
            : "modified",
      added: hunks.reduce((n, h) => n + h.afterLines.length, 0),
      removed: hunks.reduce((n, h) => n + h.beforeLines.length, 0),
      hunks,
    });
  }
  for (const [path] of currentDocs) {
    if (!snapshotPaths.has(path)) {
      const doc = currentDocs.get(path);
      const fetched = await ProjectEntityHandler.promises.getDoc(
        projectId,
        doc._id,
      );
      files.push({
        path,
        status: "added-since-release",
        added: (fetched.lines || []).length,
        removed: 0,
        hunks: [],
      });
    }
  }
  return {
    releaseId: String(release._id),
    tag: release.tag,
    version: release.version,
    files,
  };
}

const ProjectReleasesManager = {
  createRelease,
  listReleases,
  getRelease,
  diffReleaseAgainstCurrent,
  promises: {
    createRelease,
    listReleases,
    getRelease,
    diffReleaseAgainstCurrent,
  },
};

export default ProjectReleasesManager;
