import OError from "@overleaf/o-error";
import logger from "@overleaf/logger";
import { AuditEntry } from "../../models/AuditEntry.mjs";
import { ObjectId } from "../../infrastructure/mongodb.mjs";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function _asObjectIdOrNull(value) {
  if (value == null || value === "") return null;
  try {
    return new ObjectId(String(value));
  } catch {
    return null;
  }
}

/**
 * Record an entry in the unified audit log.
 *
 * Never throws to the caller: audit failures are logged, not propagated,
 * so a logging problem can never take down the audited operation.
 */
async function recordAudit({
  actorId = null,
  actorType = "user",
  action,
  targetType,
  targetId,
  projectId = null,
  info = {},
  req = null,
  ipAddress = null,
  userAgent = null,
}) {
  if (!action) {
    throw new OError("missing action for audit log", { targetType, targetId });
  }
  if (!targetType || !targetId) {
    throw new OError("missing target for audit log", { action });
  }

  if (req != null) {
    ipAddress =
      ipAddress ||
      (typeof req.ip === "string" ? req.ip : undefined) ||
      (req.socket && req.socket.remoteAddress) ||
      undefined;
    userAgent = userAgent || req.headers?.["user-agent"] || undefined;
  }

  const entry = {
    actorId: _asObjectIdOrNull(actorId),
    actorType,
    action,
    targetType,
    targetId: String(targetId),
    projectId: _asObjectIdOrNull(projectId),
    info: info && Object.keys(info).length ? info : {},
    ipAddress: ipAddress || undefined,
    userAgent: userAgent || undefined,
    timestamp: new Date(),
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await AuditEntry.create(entry);
      return;
    } catch (err) {
      if (attempt === 2) {
        logger.error({ err, entry }, "failed to write unified audit log entry");
      } else {
        logger.warn({ err }, "retrying unified audit log write");
      }
    }
  }
}

/**
 * Query audit entries with optional filters. Returns { entries, total }.
 * Filters: targetType, targetId, actorId, action, projectId, before, after.
 */
async function query({
  targetType,
  targetId,
  actorId,
  action,
  projectId,
  before,
  after,
  limit = DEFAULT_LIMIT,
  offset = 0,
}) {
  const criteria = {};
  // Case-insensitive substring match so "kill" finds "admin-kill-job".
  if (action)
    criteria.action = {
      $regex: escapeRegExp(String(action)),
      $options: "i",
    };
  if (targetType) criteria.targetType = String(targetType);
  if (targetId) criteria.targetId = String(targetId);
  const actorOid = _asObjectIdOrNull(actorId);
  if (actorOid) criteria.actorId = actorOid;
  const projectOid = _asObjectIdOrNull(projectId);
  if (projectOid) criteria.projectId = projectOid;
  const timestamp = {};
  if (before) timestamp.$lt = new Date(before);
  if (after) timestamp.$gt = new Date(after);
  if (Object.keys(timestamp).length) criteria.timestamp = timestamp;

  limit = Math.min(
    Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  offset = Math.max(parseInt(offset, 10) || 0, 0);

  const [entries, total] = await Promise.all([
    AuditEntry.find(criteria)
      .sort({ timestamp: -1 })
      .skip(offset)
      .limit(limit)
      .lean()
      .exec(),
    AuditEntry.countDocuments(criteria),
  ]);

  return { entries, total, limit, offset };
}

const AuditLogManager = {
  recordAudit,
  promises: {
    recordAudit,
    query,
  },
};

export default AuditLogManager;
