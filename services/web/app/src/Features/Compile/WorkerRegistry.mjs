import Settings from "@overleaf/settings";
import ProjectGetter from "../Project/ProjectGetter.mjs";
import { fetchJson } from "@overleaf/fetch-utils";
import RedisWrapper from "../../infrastructure/RedisWrapper.mjs";

// Registry of compile workers configured via Settings.apis.clsi.workers
// ([{ id, url }, ...]). Falls back to the single default CLSI url when no
// workers are configured. Projects may pin a worker explicitly via
// project.compileWorkerId; the pin is honored only while the worker is
// configured, and skipped when its last known health check failed so a
// dead pinned worker cannot take the project's compiles down.

const PIN_CACHE_TTL_MS = 30_000;
const pinCache = new Map(); // projectId -> { workerId, expiresAt }
// Shared worker-health cache (PLANS 5): the admin Workers page and the
// compile placement path both read it, so fresh probes run at most once per
// TTL instead of per request. Fail-open: any Redis or probe error degrades
// to "no health information", which leaves pins in force rather than
// blocking compiles.
const HEALTH_CACHE_KEY = "admin:workers:health";
const HEALTH_CACHE_TTL_SECONDS = 15;
const healthClient = RedisWrapper.client("job_queue");

async function probeWorker(worker) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const details = await fetchJson(`${worker.url}/health_details`, {
      signal: controller.signal,
    });
    return {
      id: worker.id,
      url: worker.url,
      ok: Boolean(details.ok),
      concurrency: details.concurrency || null,
      diskFreePct: details.disk?.freePct ?? null,
      uptimeS: details.uptimeS ?? null,
      versions: details.versions || {},
    };
  } catch (err) {
    return {
      id: worker.id,
      url: worker.url,
      ok: false,
      error: String(err.message || err).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Current health for all configured workers as `{ checkedAt, workers }`
// (the shape the admin Workers page renders). Serves the shared cache when
// fresh; otherwise probes every worker and rewrites the cache. Never
// throws: callers treat missing health as "unknown".
export async function getWorkerHealth() {
  try {
    const cached = await healthClient.get(HEALTH_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed?.workers)) {
        return parsed;
      }
    }
  } catch {
    // fall through to fresh probes
  }
  const workers = configuredWorkers();
  const probed = await Promise.all(workers.map(probeWorker));
  const result = {
    checkedAt: new Date().toISOString(),
    workers: probed,
  };
  try {
    await healthClient.set(
      HEALTH_CACHE_KEY,
      JSON.stringify(result),
      "EX",
      HEALTH_CACHE_TTL_SECONDS,
    );
  } catch {
    // cache is best-effort
  }
  return result;
}

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

async function getPinnedWorkerId(projectId, project = null) {
  const cached = pinCache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.workerId;
  }
  let workerId = null;
  try {
    let doc = project;
    if (doc == null) {
      doc = await ProjectGetter.promises.getProject(projectId, {
        compileWorkerId: 1,
      });
    }
    workerId = doc?.compileWorkerId || null;
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
export async function resolveBaseUrl(
  projectId,
  lastHealthByWorker = null,
  project = null,
) {
  const workerId = await getPinnedWorkerId(projectId, project);
  if (workerId != null) {
    const worker = getWorker(workerId);
    if (worker != null) {
      const health = await healthOfWorker(workerId, lastHealthByWorker);
      if (health == null || health.ok) {
        return { baseUrl: worker.url, workerId };
      }
      // Pinned worker known to be unhealthy: fall back to automatic.
    }
  }
  return { baseUrl: defaultBaseUrl(), workerId: null };
}

// Health of a single worker: an explicit map wins (tests, callers with
// fresher data); otherwise the shared cached health is consulted, which
// covers the compile path (CompileManager placement attribution and
// ClsiManager URL selection) without extra plumbing. Unknown health is
// treated as healthy so a cache failure never blocks compiles.
async function healthOfWorker(workerId, lastHealthByWorker) {
  if (lastHealthByWorker != null) {
    return lastHealthByWorker[workerId] || null;
  }
  const health = await getWorkerHealth();
  return health.workers.find((worker) => worker.id === workerId) || null;
}

export default {
  configuredWorkers,
  defaultBaseUrl,
  getWorker,
  getWorkerHealth,
  resolveBaseUrl,
  invalidatePinCache,
  promises: {
    getWorkerHealth,
    resolveBaseUrl,
    invalidatePinCache,
  },
};
