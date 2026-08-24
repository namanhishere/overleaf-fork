import { expressify } from "@overleaf/promise-utils";
import SessionManager from "../Authentication/SessionManager.mjs";
import CompileJobManager from "../Compile/CompileJobManager.mjs";
import CompileManager from "../Compile/CompileManager.mjs";
import ClsiManager from "../Compile/ClsiManager.mjs";
import AuditLogManager from "../Audit/AuditLogManager.mjs";

// GET /admin/jobs?status=&userId=&projectId=&limit=&offset=
async function listJobs(req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { jobs, total } = await CompileJobManager.list({
    status: req.query.status,
    userId: req.query.userId,
    projectId: req.query.projectId,
    limit,
    offset,
  });
  res.json({ jobs, total, limit, offset });
}

// POST /admin/jobs/:jobId/kill
async function killJob(req, res) {
  const job = await CompileJobManager.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }
  if (!["queued", "running"].includes(job.status)) {
    return res.status(409).json({ error: `job already ${job.status}` });
  }

  if (job.status === "running") {
    const limits = await CompileManager.promises.getProjectCompileLimits(
      job.projectId,
    );
    // Stop the compile on the worker the user's session is pinned to.
    await ClsiManager.promises.stopCompile(
      String(job.projectId),
      job.userId ? String(job.userId) : undefined,
      limits,
    );
  }
  await CompileJobManager.cancelActiveJobs(job.projectId, "killed by admin");
  await AuditLogManager.promises.recordAudit({
    actorId: SessionManager.getLoggedInUserId(req.session),
    action: "admin-kill-job",
    targetType: "job",
    targetId: String(job.jobId),
    projectId: job.projectId,
    info: { before: { status: job.status }, userId: job.userId },
    ipAddress: req.ip,
  });
  res.json({ ok: true });
}

// POST /admin/jobs/:jobId/retry — re-run a failed/timeout/cancelled
// compile through the normal compile path (PLANS 3 "Retry"). A fresh job
// is created; the original record is never mutated.
async function retryJob(req, res) {
  const job = await CompileJobManager.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }
  if (!["failed", "timeout", "cancelled"].includes(job.status)) {
    return res.status(409).json({ error: `cannot retry a ${job.status} job` });
  }
  const result = await CompileManager.promises.compile(
    String(job.projectId),
    job.userId ? String(job.userId) : undefined,
  );
  await AuditLogManager.promises.recordAudit({
    actorId: SessionManager.getLoggedInUserId(req.session),
    action: "admin-retry-job",
    targetType: "job",
    targetId: String(job.jobId),
    projectId: job.projectId,
    info: {
      before: { status: job.status },
      result: result.status,
      userId: job.userId,
    },
    ipAddress: req.ip,
  });
  res.json({ ok: true, result: result.status });
}

// GET /admin/jobs/:jobId/log
async function getJobLog(req, res) {
  const job = await CompileJobManager.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "job not found" });
  }
  res.json({
    jobId: job.jobId,
    status: job.status,
    logExcerpt: job.logExcerpt || null,
    buildId: job.buildId || null,
    projectId: job.projectId,
  });
}

export default {
  listJobs: expressify(listJobs),
  killJob: expressify(killJob),
  retryJob: expressify(retryJob),
  getJobLog: expressify(getJobLog),
};
