import Settings from "@overleaf/settings";
import { fetchJson } from "@overleaf/fetch-utils";
import { expressify } from "@overleaf/promise-utils";
import RedisWrapper from "../../infrastructure/RedisWrapper.mjs";

const healthClient = RedisWrapper.client("job_queue");

const HEALTH_CACHE_KEY = "admin:workers:health";
const HEALTH_CACHE_TTL_SECONDS = 15;

function configuredWorkers() {
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

// GET /admin/workers
async function listWorkers(req, res) {
  const workers = configuredWorkers();
  let cached = null;
  try {
    cached = await healthClient.get(HEALTH_CACHE_KEY);
  } catch {
    cached = null;
  }

  if (cached) {
    try {
      return res.json(JSON.parse(cached));
    } catch {
      // fall through to a fresh probe
    }
  }

  const result = {
    checkedAt: new Date().toISOString(),
    workers: await Promise.all(workers.map(probeWorker)),
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
  res.json(result);
}

export default {
  listWorkers: expressify(listWorkers),
};
