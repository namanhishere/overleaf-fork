import Settings from "@overleaf/settings";
import ProjectGetter from "../Project/ProjectGetter.mjs";

// Registry of compile workers configured via Settings.apis.clsi.workers
// ([{ id, url }, ...]). Falls back to the single default CLSI url when no
// workers are configured. Projects may pin a worker explicitly via
// project.compileWorkerId; the pin is honored only while the worker is
// configured, and skipped when its last known health check failed so a
// dead pinned worker cannot take the project's compiles down.

const PIN_CACHE_TTL_MS = 30_000;
const pinCache = new Map(); // projectId -> { workerId, expiresAt }

export function configuredWorkers() {
  const workers =
    Settings.apis?.clsi?.workers ||
    (Settings.apis?.clsi?.url
      ? [
          {
            id: Settings.clsi?.CLSI_SERVER_ID || "clsi-0",
            url: Settings.apis.clsi.url,
          },
        ]
      : []);
  return workers;
}

export function defaultBaseUrl() {
  return Settings.apis?.clsi?.url;
}

export function getWorker(workerId) {
  if (workerId == null) return null;
  return configuredWorkers().find((w) => w.id === workerId) || null;
}

async function getPinnedWorkerId(projectId) {
  const cached = pinCache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.workerId;
  }
  let workerId = null;
  try {
    const project = await ProjectGetter.promises.getProject(projectId, {
      compileWorkerId: 1,
    });
    workerId = project?.compileWorkerId || null;
  } catch {
    workerId = null;
  }
  pinCache.set(projectId, {
    workerId,
    expiresAt: Date.now() + PIN_CACHE_TTL_MS,
  });
  return workerId;
}

export function invalidatePinCache(projectId) {
  if (projectId == null) {
    pinCache.clear();
  } else {
    pinCache.delete(String(projectId));
  }
}

/**
 * Resolve the base URL that should receive this project's compile
 * requests. Returns { baseUrl, workerId } where workerId is the pinned
 * worker actually used (null for automatic placement).
 */
export async function resolveBaseUrl(projectId, lastHealthByWorker = null) {
  const workerId = await getPinnedWorkerId(projectId);
  if (workerId != null) {
    const worker = getWorker(workerId);
    if (worker != null) {
      const health = lastHealthByWorker?.[workerId];
      if (health == null || health.ok) {
        return { baseUrl: worker.url, workerId };
      }
      // Pinned worker known to be unhealthy: fall back to automatic.
    }
  }
  return { baseUrl: defaultBaseUrl(), workerId: null };
}

export default {
  configuredWorkers,
  defaultBaseUrl,
  getWorker,
  resolveBaseUrl,
  invalidatePinCache,
  promises: {
    resolveBaseUrl,
    invalidatePinCache,
  },
};
