import Crypto from "node:crypto";
import logger from "@overleaf/logger";
import OError from "@overleaf/o-error";
import Settings from "@overleaf/settings";
import RedisWrapper from "../../infrastructure/RedisWrapper.mjs";
import { CompileJob } from "../../models/CompileJob.mjs";
import { enqueue, Consumer } from "@overleaf/job-queue";

const rclient = RedisWrapper.client("job_queue");

const STREAM = "jobs:stream";
const GROUP = "compilers";
const CONSUMER_NAME = `web-inline-${process.pid}`;

// Platform-level concurrency caps. Per-plan compile limits (timeout etc.)
// remain per-user features; these caps protect the platform as a whole.
Settings.compileConcurrencyLimits ||= {
  perUser: parseInt(process.env.OVERLEAF_COMPILE_CONCURRENCY_PER_USER, 10) || 3,
  perProject:
    parseInt(process.env.OVERLEAF_COMPILE_CONCURRENCY_PER_PROJECT, 10) || 1,
};

export class CompileLimitReachedError extends OError {
  constructor(scope) {
    super("compile concurrency limit reached", { scope });
  }
}

function slotKey(scope, id) {
  return scope === "user" ? `activeCompiles:u:${id}` : `activeCompiles:p:${id}`;
}

async function acquireSlot(scope, id, jobId) {
  const key = slotKey(scope, id);
  const count = await rclient.scard(key);
  const cap =
    scope === "user"
      ? Settings.compileConcurrencyLimits.perUser
      : Settings.compileConcurrencyLimits.perProject;
  if (count >= cap) {
    throw new CompileLimitReachedError(scope);
  }
  await rclient.sadd(key, jobId);
}

async function releaseSlot(scope, id, jobId) {
  try {
    await rclient.srem(slotKey(scope, id), jobId);
  } catch (err) {
    logger.warn({ err, scope, id, jobId }, "failed to release compile slot");
  }
}

const pendingDispatches = new Map(); // jobId -> { resolve, reject }
// Resource telemetry written by the compile worker into
// `clsi:job:{jobId}`. Values are strings (Redis hashes); missing or
// non-numeric fields are dropped. Failures never block finalization.
async function readWorkerTelemetry(jobId) {
  try {
    if (typeof rclient.hgetall !== "function") return {};
    const raw = await rclient.hgetall(`clsi:job:${jobId}`);
    if (raw == null) return {};
    const num = (value) => {
      if (value == null || value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const out = {};
    for (const key of [
      "runtimeMs",
      "peakCpuPercent",
      "peakRssBytes",
      "peakDiskBytes",
      "pid",
      "exitCode",
    ]) {
      const n = num(raw[key]);
      if (n != null) out[key] = n;
    }
    for (const key of ["workerId", "logExcerpt"]) {
      if (raw[key]) out[key] = raw[key];
    }
    return out;
  } catch (err) {
    logger.warn({ err, jobId }, "failed to read compile job telemetry");
    return {};
  }
}

let consumerStarted = false;

async function startConsumer() {
  if (consumerStarted) {
    return;
  }
  consumerStarted = true;
  const consumer = new Consumer(rclient, {
    stream: STREAM,
    group: GROUP,
    consumerName: CONSUMER_NAME,
    maxAttempts: 2,
    claimIdleMs: 30_000,
  });
  // Fire-and-forget loop; dispatches resolve the promise handed to
  // dispatch(). If no resolver is registered (e.g. after a process
  // restart), the message is dropped and the Mongo row is failed so the
  // admin job list does not show it as running forever.
  consumer
    .run(async (payload) => {
      const pending = pendingDispatches.get(payload.jobId);
      if (pending == null) {
        logger.warn({ jobId: payload.jobId }, "no dispatcher for queued job");
        await CompileJob.updateOne(
          { jobId: payload.jobId, status: { $in: ["queued", "running"] } },
          {
            status: "failed",
            finishedAt: new Date(),
            error: "dispatch lost: no handler registered for this job",
          },
        ).exec();
        return;
      }
      pendingDispatches.delete(payload.jobId);
      pending.resolve();
    })
    .catch((err) => {
      logger.error({ err }, "compile job consumer crashed");
      consumerStarted = false;
    });
  startReaper();
}

// Jobs whose row was created but never finalized (process crash between
// enqueue and executor, lost worker, etc.) must not sit in the admin job
// list as "running" forever. The reaper fails any active row older than
// its compile timeout (or a hard cap when the timeout is unknown).
const REAP_INTERVAL_MS = 60_000;
const REAP_DEFAULT_MAX_AGE_MS = 30 * 60_000;

async function reapStaleJobs(now = Date.now()) {
  const cutoff = new Date(now - REAP_DEFAULT_MAX_AGE_MS);
  const result = await CompileJob.updateMany(
    {
      status: { $in: ["queued", "running"] },
      queuedAt: { $lt: cutoff },
    },
    {
      status: "timeout",
      finishedAt: new Date(now),
      error: "reaped: job exceeded maximum runtime without completing",
    },
  ).exec();
  return result.modifiedCount || 0;
}

let reaperTimer = null;

function startReaper() {
  if (reaperTimer != null) return;
  reaperTimer = setInterval(() => {
    reapStaleJobs().catch((err) =>
      logger.warn({ err }, "compile job reaper failed"),
    );
  }, REAP_INTERVAL_MS);
  reaperTimer.unref?.();
}

const CompileJobManager = {
  CompileLimitReachedError,
  reapStaleJobs,

  async acquireAllSlots(userId, projectId, jobId) {
    await acquireSlot("project", projectId, jobId);
    try {
      await acquireSlot("user", userId, jobId);
    } catch (err) {
      await releaseSlot("project", projectId, jobId);
      throw err;
    }
  },

  async releaseAllSlots(userId, projectId, jobId) {
    await releaseSlot("project", projectId, jobId);
    await releaseSlot("user", userId, jobId);
  },

  /**
   * Create the durable job record. Returns the job document.
   * Enqueueing happens in dispatch(), AFTER this process has registered
   * its dispatcher, so the consumer can never observe the message before
   * a handler exists (dispatch-loss race).
   */
  async startJob({
    jobId = Crypto.randomUUID(),
    projectId,
    userId,
    priority = 0,
    imageName = null,
    compiler = null,
    timeoutMs = null,
    buildId = null,
  }) {
    return CompileJob.create({
      jobId,
      projectId,
      userId,
      status: "queued",
      priority,
      imageName,
      compiler,
      timeoutMs,
      buildId,
    });
  },

  /**
   * Wait for the queue to hand this job back to this process, then run the
   * provided executor thunk. The stream payload carries only the jobId —
   * project content is never serialized through Redis; the executor closes
   * over everything it needs in-process.
   *
   * The dispatcher MUST be registered before the message is enqueued:
   * awaiting startConsumer() yields to the event loop, and a consumer that
   * is already polling could consume (and drop) the message during that
   * window.
   */
  async dispatch(job, executor) {
    const jobId = String(job.jobId);
    await startConsumer();
    const promise = new Promise((resolve, reject) => {
      pendingDispatches.set(jobId, { resolve, reject });
    });
    try {
      await enqueue(rclient, STREAM, {
        type: "compile",
        priority: job.priority || 0,
        payload: { jobId },
      });
      await promise;
      return await executor();
    } finally {
      pendingDispatches.delete(jobId);
    }
  },

  /**
   * Mark the job started (called when the executor begins).
   */
  async markStarted(jobId, workerId = null) {
    await CompileJob.updateOne(
      { jobId },
      { status: "running", startedAt: new Date(), workerId },
    ).exec();
  },

  /**
   * Finalize the job record with outcome and resource stats. Resource
   * stats (runtime/CPU/RAM/log) are sampled by the compile worker into the
   * Redis hash `clsi:job:{jobId}`; merge whatever the caller did not
   * provide so the admin dashboard shows full telemetry.
   */
  async finishJob(
    jobId,
    { status, error = null, stats = {}, exitCode = null },
  ) {
    const update = {
      status,
      finishedAt: new Date(),
    };
    if (error != null)
      update.error = String(error.message || error).slice(0, 500);
    const telemetry = await readWorkerTelemetry(jobId);
    const merged = { ...telemetry, ...stats };
    if (exitCode != null) update.exitCode = exitCode;
    else if (merged.exitCode != null) update.exitCode = merged.exitCode;
    if (merged.runtimeMs != null) update.runtimeMs = merged.runtimeMs;
    if (merged.peakCpuPercent != null)
      update.peakCpuPercent = merged.peakCpuPercent;
    if (merged.peakRssBytes != null) update.peakRssBytes = merged.peakRssBytes;
    if (merged.peakDiskBytes != null)
      update.peakDiskBytes = merged.peakDiskBytes;
    if (merged.logExcerpt != null)
      update.logExcerpt = String(merged.logExcerpt).slice(-8192);
    if (merged.workerId != null) update.workerId = merged.workerId;
    if (merged.pid != null) update.pid = merged.pid;
    await CompileJob.updateOne(
      // Only finalize rows still in an active state; a concurrent cancel
      // must not be overwritten by the losing request's error handler.
      { jobId, status: { $in: ["queued", "running"] } },
      update,
    ).exec();
  },

  /**
   * Cancel any running/queued jobs for a project (used by stop endpoints).
   * Returns the cancelled jobIds.
   */
  async cancelActiveJobs(projectId, errorText = "cancelled") {
    const jobs = await CompileJob.find({
      projectId,
      status: { $in: ["queued", "running"] },
    })
      .lean()
      .exec();
    for (const job of jobs) {
      await this.finishJob(job.jobId, {
        status: "cancelled",
        error: errorText,
      });
    }
    return jobs.map((job) => job.jobId);
  },

  async listForProject(projectId, { limit = 20, offset = 0 } = {}) {
    return CompileJob.find({ projectId })
      .sort({ queuedAt: -1 })
      .skip(Math.max(offset, 0))
      .limit(Math.min(limit, 100))
      .lean()
      .exec();
  },

  async get(jobId) {
    return CompileJob.findOne({ jobId }).lean().exec();
  },

  async list({ status, userId, projectId, limit = 50, offset = 0 } = {}) {
    const criteria = {};
    if (status) criteria.status = status;
    if (userId) criteria.userId = userId;
    if (projectId) criteria.projectId = projectId;
    const [jobs, total] = await Promise.all([
      CompileJob.find(criteria)
        .sort({ queuedAt: -1 })
        .skip(Math.max(offset, 0))
        .limit(Math.min(limit, 200))
        .lean()
        .exec(),
      CompileJob.countDocuments(criteria),
    ]);
    return { jobs, total, limit, offset };
  },
};

export default CompileJobManager;
