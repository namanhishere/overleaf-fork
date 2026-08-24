import { expressify } from "@overleaf/promise-utils";
import SessionManager from "../Authentication/SessionManager.mjs";
import ProjectReleasesManager from "./ProjectReleasesManager.mjs";

// GET /project/:Project_id/api/releases
async function listReleases(req, res) {
  const projectId = req.params.Project_id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const result = await ProjectReleasesManager.promises.listReleases(projectId, {
    limit,
    offset,
  });
  res.json(result);
}

// POST /project/:Project_id/api/releases  { tag, notes?, buildId?, version? }
// GET /project/:Project_id/api/releases/:releaseId/diff
async function diffRelease(req, res) {
  try {
    const diff =
      await ProjectReleasesManager.promises.diffReleaseAgainstCurrent(
        req.params.Project_id,
        req.params.releaseId,
      );
    res.json(diff);
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 409) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    throw err;
  }
}

async function createRelease(req, res) {
  const projectId = req.params.Project_id;
  const userId = SessionManager.getLoggedInUserId(req.session);
  const body = req.body || {};
  try {
    const release = await ProjectReleasesManager.promises.createRelease(
      projectId,
      {
        tag: body.tag,
        notes: body.notes,
        buildId: body.buildId,
        version: body.version,
        userId,
      },
    );
    res.status(201).json({ release });
  } catch (err) {
    const msg = String(err?.message || err);
    if (
      msg.includes("invalid release tag") ||
      msg.includes("no successful compile") ||
      msg.includes("duplicate release tag")
    ) {
      return res.status(400).json({ error: msg });
    }
    throw err;
  }
}

export default {
  listReleases: expressify(listReleases),
  createRelease: expressify(createRelease),
  diffRelease: expressify(diffRelease),
};
