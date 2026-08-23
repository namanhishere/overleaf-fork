import OError from "@overleaf/o-error";
import { CompilationProfile } from "../../models/CompilationProfile.mjs";
import EditorController from "../Editor/EditorController.mjs";
import AuditLogManager from "../Audit/AuditLogManager.mjs";

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function cleanProfileFields(body) {
  const out = {};
  if (body.label != null) out.label = String(body.label).trim().slice(0, 100);
  if (body.imageName !== undefined)
    out.imageName = body.imageName ? String(body.imageName).trim() : null;
  if (body.compiler !== undefined)
    out.compiler = body.compiler ? String(body.compiler) : null;
  if (body.texLiveVersion !== undefined)
    out.texLiveVersion = body.texLiveVersion
      ? String(body.texLiveVersion).trim()
      : null;
  if (body.timeoutMinutes !== undefined)
    out.timeoutMinutes = body.timeoutMinutes
      ? Math.min(Math.max(parseInt(body.timeoutMinutes, 10) || 0, 1), 30)
      : null;
  if (body.description !== undefined)
    out.description = String(body.description).slice(0, 2000);
  return out;
}

async function listProfiles() {
  return CompilationProfile.find({}).sort({ label: 1 }).lean().exec();
}

async function getProfile(slug) {
  return CompilationProfile.findOne({ slug }).lean().exec();
}

async function createProfile(body, userId = null) {
  const slug = String(body.slug || "")
    .trim()
    .toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new OError("invalid profile slug", { slug });
  }
  if (!body.label || !String(body.label).trim()) {
    throw new OError("missing profile label");
  }
  const fields = cleanProfileFields(body);
  try {
    const profile = await CompilationProfile.create({
      slug,
      ...fields,
      createdBy: userId,
    });
    await AuditLogManager.promises.recordAudit({
      actorId: userId,
      action: "profile-created",
      targetType: "compilation-profile",
      targetId: slug,
      info: { after: fields },
    });
    return profile.toObject();
  } catch (err) {
    if (err?.code === 11000) {
      throw new OError("duplicate profile slug", { slug });
    }
    throw err;
  }
}

async function updateProfile(slug, body, userId = null) {
  const before = await getProfile(slug);
  if (before == null) {
    throw new OError("profile not found", { slug });
  }
  const fields = cleanProfileFields(body);
  const after = await CompilationProfile.findOneAndUpdate(
    { slug },
    { $set: fields },
    { new: true },
  )
    .lean()
    .exec();
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: "profile-updated",
    targetType: "compilation-profile",
    targetId: slug,
    info: { before, after },
  });
  return after;
}

async function deleteProfile(slug, userId = null) {
  const before = await getProfile(slug);
  if (before == null) {
    throw new OError("profile not found", { slug });
  }
  await CompilationProfile.deleteOne({ slug }).exec();
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: "profile-deleted",
    targetType: "compilation-profile",
    targetId: slug,
    info: { before },
  });
}

/**
 * Apply a profile to a project: sets the project compiler and image via
 * the standard settings path so the change goes through the editor's
 * history and the next compile picks it up.
 */
async function applyToProject(slug, projectId, userId = null) {
  const profile = await getProfile(slug);
  if (profile == null) {
    throw new OError("profile not found", { slug });
  }
  if (profile.compiler != null) {
    await EditorController.promises.setCompiler(projectId, profile.compiler);
  }
  if (profile.imageName != null) {
    await EditorController.promises.setImageName(projectId, profile.imageName);
  }
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: "profile-applied",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: {
      profile: slug,
      compiler: profile.compiler,
      imageName: profile.imageName,
      texLiveVersion: profile.texLiveVersion,
    },
  });
  return profile;
}

const CompilationProfileManager = {
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  applyToProject,
  promises: {
    listProfiles,
    getProfile,
    createProfile,
    updateProfile,
    deleteProfile,
    applyToProject,
  },
};

export default CompilationProfileManager;
