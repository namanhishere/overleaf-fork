import { expressify } from "@overleaf/promise-utils";
import WorkerRegistry from "../Compile/WorkerRegistry.mjs";
import { Project } from "../../models/Project.mjs";
import { ObjectId } from "../../infrastructure/mongodb.mjs";
import SessionManager from "../Authentication/SessionManager.mjs";
import AuditLogManager from "../Audit/AuditLogManager.mjs";

// GET /admin/workers
async function listWorkers(req, res) {
  // Shared cached health from the worker registry: cache hits avoid the
  // N x 2s probe fan-out on every page load, and the registry is
  // fail-open, so a broken Redis or probe never blocks the page.
  res.json(await WorkerRegistry.promises.getWorkerHealth());
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
