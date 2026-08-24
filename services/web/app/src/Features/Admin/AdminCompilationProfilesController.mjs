import { expressify } from "@overleaf/promise-utils";
import SessionManager from "../Authentication/SessionManager.mjs";
import CompilationProfileManager from "../Compile/CompilationProfileManager.mjs";

function _userId(req) {
  return SessionManager.getLoggedInUserId(req.session);
}

// GET /admin/api/profiles
async function listProfiles(req, res) {
  const profiles = await CompilationProfileManager.promises.listProfiles();
  res.json({ profiles });
}

// POST /admin/api/profiles
async function createProfile(req, res) {
  try {
    const profile = await CompilationProfileManager.promises.createProfile(
      req.body || {},
      _userId(req),
    );
    res.status(201).json({ profile });
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("invalid profile slug") || msg.includes("duplicate")) {
      return res.status(400).json({ error: msg });
    }
    if (msg.includes("missing profile label")) {
      return res.status(400).json({ error: msg });
    }
    throw err;
  }
}

// PATCH /admin/api/profiles/:slug
async function updateProfile(req, res) {
  try {
    const profile = await CompilationProfileManager.promises.updateProfile(
      req.params.slug,
      req.body || {},
      _userId(req),
    );
    res.json({ profile });
  } catch (err) {
    if (String(err?.message).includes("profile not found")) {
      return res.status(404).json({ error: "profile not found" });
    }
    throw err;
  }
}

// DELETE /admin/api/profiles/:slug
async function deleteProfile(req, res) {
  try {
    await CompilationProfileManager.promises.deleteProfile(
      req.params.slug,
      _userId(req),
    );
    res.sendStatus(204);
  } catch (err) {
    if (String(err?.message).includes("profile not found")) {
      return res.status(404).json({ error: "profile not found" });
    }
    throw err;
  }
}

// POST /admin/api/profiles/:slug/apply  { projectId }
async function applyToProject(req, res) {
  const projectId = req.body?.projectId;
  if (!projectId || !/^[a-f0-9]{24}$/.test(String(projectId))) {
    return res.status(400).json({ error: "missing or invalid projectId" });
  }
  try {
    const profile = await CompilationProfileManager.promises.applyToProject(
      req.params.slug,
      projectId,
      _userId(req),
    );
    res.json({
      ok: true,
      applied: { compiler: profile.compiler, imageName: profile.imageName },
    });
  } catch (err) {
    if (String(err?.message).includes("profile not found")) {
      return res.status(404).json({ error: "profile not found" });
    }
    throw err;
  }
}

export default {
  listProfiles: expressify(listProfiles),
  createProfile: expressify(createProfile),
  updateProfile: expressify(updateProfile),
  deleteProfile: expressify(deleteProfile),
  applyToProject: expressify(applyToProject),
};
