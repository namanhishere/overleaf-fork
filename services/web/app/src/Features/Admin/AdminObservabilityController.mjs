import { expressify } from "@overleaf/promise-utils";
import { CompileJob } from "../../models/CompileJob.mjs";
import { User } from "../../models/User.mjs";
import { AuditEntry } from "../../models/AuditEntry.mjs";
import RedisWrapper from "../../infrastructure/RedisWrapper.mjs";

const rclient = RedisWrapper.client("job_queue");

const STREAM = "jobs:stream";

async function compileStats(since) {
  const rows = await CompileJob.aggregate([
    { $match: { queuedAt: { $gte: since } } },
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
        avgRuntimeMs: { $avg: "$runtimeMs" },
      },
    },
  ]).exec();
  const byStatus = {};
  let total = 0;
  let runtimeSumMs = 0;
  let runtimeCount = 0;
  for (const row of rows) {
    byStatus[row._id] = row.count;
    total += row.count;
    if (row.avgRuntimeMs != null) {
      runtimeSumMs += row.avgRuntimeMs * row.count;
      runtimeCount += row.count;
    }
  }
  const failed =
    (byStatus.failed || 0) + (byStatus.timeout || 0) + (byStatus.discarded || 0);
  return {
    total,
    byStatus,
    avgRuntimeMs: runtimeCount > 0 ? Math.round(runtimeSumMs / runtimeCount) : null,
    failureRate: total > 0 ? Math.round((failed / total) * 1000) / 10 : null,
  };
}

async function userStats() {
  const [total, admins, suspended] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ isAdmin: true }),
    User.countDocuments({ suspended: true }),
  ]);
  return { total, admins, suspended };
}

async function auditStats(since) {
  return AuditEntry.countDocuments({ timestamp: { $gte: since } });
}


async function queueStats() {
  try {
    const pending = await rclient.xpending(STREAM, "compilers");
    const pendingCount = pending == null ? 0 : pending[0] || 0;
    let dlq = 0;
    try {
      dlq = await rclient.xlen(`${STREAM}:dlq`);
    } catch {
      dlq = 0;
    }
    return { pending: pendingCount, dlq };
  } catch {
    return { pending: null, dlq: null };
  }
}

async function workerHealth() {
  try {
    const cached = await rclient.get("admin:workers:health");
    if (cached == null) return null;
    return JSON.parse(cached);
  } catch {
    return null;
  }
}

// GET /admin/api/observability
async function getObservability(req, res) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [
    compiles,
    users,
    auditEntries,
    queue,
    workers,
  ] = await Promise.all([
    compileStats(since),
    userStats(),
    auditStats(since),
    queueStats(),
    workerHealth(),
  ]);
  res.json({
    window: { since: since.toISOString(), hours: 24 },
    compiles,
    users,
    auditEntries,
    queue,
    workers,
    generatedAt: new Date().toISOString(),
  });
}

export default {
  getObservability: expressify(getObservability),
};
