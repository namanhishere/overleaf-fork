import Settings from "@overleaf/settings";
import { fetchJson } from "@overleaf/fetch-utils";
import { expressify } from "@overleaf/promise-utils";
import RedisWrapper from "../../infrastructure/RedisWrapper.mjs";
import WorkerRegistry from "../Compile/WorkerRegistry.mjs";
import { Project } from "../../models/Project.mjs";
import { ObjectId } from "../../infrastructure/mongodb.mjs";
import SessionManager from "../Authentication/SessionManager.mjs";
import AuditLogManager from "../Audit/AuditLogManager.mjs";

const healthClient = RedisWrapper.client("job_queue");

// Worker list comes from the shared registry (Settings.apis.clsi.workers
// or the single default CLSI url).
function configuredWorkers() {
  return WorkerRegistry.configuredWorkers();
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

// POST /admin/api/workers/pin  { projectId, workerId | null }
async function pinWorker(req, res) {
  const projectId = String(req.body?.projectId || "");
  const workerId = req.body?.workerId || null;
  if (!/^[a-f0-9]{24}$/.test(projectId)) {
    return res.status(400).json({ error: "missing or invalid projectId" });
  }
  if (workerId != null && WorkerRegistry.getWorker(workerId) == null) {
    return res.status(400).json({ error: "unknown workerId" });
  }
  await Project.updateOne(
    { _id: new ObjectId(projectId) },
    { $set: { compileWorkerId: workerId } },
  ).exec();
  WorkerRegistry.invalidatePinCache(projectId);
  await AuditLogManager.promises.recordAudit({
    actorId: SessionManager.getLoggedInUserId(req.session),
    action: workerId == null ? "worker-pin-cleared" : "worker-pin-set",
    targetType: "project",
    targetId: projectId,
    projectId,
    info: { workerId },
  });
  res.json({ ok: true, projectId, workerId });
}

export default {
  listWorkers: expressify(listWorkers),
  pinWorker: expressify(pinWorker),
};
