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
      version: version != null ? Number(version) : null,
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

const ProjectReleasesManager = {
  createRelease,
  listReleases,
  getRelease,
  promises: { createRelease, listReleases, getRelease },
};

export default ProjectReleasesManager;
