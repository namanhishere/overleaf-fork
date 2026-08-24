import Settings from "@overleaf/settings";
import OError from "@overleaf/o-error";
import ProjectGetter from "../Project/ProjectGetter.mjs";

/**
 * Git integration boundary (PLANS 17): the platform does NOT reimplement
 * git — the bundled git-bridge service owns repositories, commits, branches
 * and push/pull. The platform's job is to expose stable clone URLs and to
 * keep releases (source snapshots + compiled PDFs) downloadable, which
 * maps release versions onto what git-bridge syncs.
 */
function getGitBridgeBaseUrl() {
  return Settings.gitBridgePublicBaseUrl || null;
}

function gitBridgeEnabled() {
  return Settings.apis?.gitBridge?.enabled ?? true;
}

async function getGitInfo(projectId, userId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    owner_ref: 1,
  });
  if (project == null) throw new OError("project not found", { projectId });
  const base = getGitBridgeBaseUrl();
  if (!base || !gitBridgeEnabled()) {
    return { enabled: false, cloneUrl: null };
  }
  const token = Settings.overleaf
    ? null // token-based auth is presented in the UI, not embedded here
    : null;
  return {
    enabled: true,
    cloneUrl: `${base.replace(/\/$/, "")}/git/project/${projectId}`,
    // git-bridge authenticates with the user's git token; the platform
    // never stores or proxies credentials.
    authNote:
      "Authenticate with your Overleaf account and a git authentication token (Account Settings > Git integration).",
  };
}

export default { getGitInfo, promises: { getGitInfo } };
