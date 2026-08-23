import { expressify } from "@overleaf/promise-utils";
import AuditLogManager from "../Audit/AuditLogManager.mjs";

const AuditLogController = {
  // Admin-facing read API: GET /admin/audit
  query: expressify(async (req, res) => {
    const { entries, total, limit, offset } =
      await AuditLogManager.promises.query({
        targetType: req.query.targetType,
        targetId: req.query.targetId,
        actorId: req.query.actorId,
        action: req.query.action,
        projectId: req.query.projectId,
        before: req.query.before,
        after: req.query.after,
        limit: req.query.limit,
        offset: req.query.offset,
      });
    res.json({ entries, total, limit, offset });
  }),

  // Internal write API for other services (basic-auth protected):
  // POST /internal/audit
  record: expressify(async (req, res) => {
    const body = req.body || {};
    await AuditLogManager.promises.recordAudit({
      actorId: body.actorId ?? null,
      actorType: body.actorType || "system",
      action: body.action,
      targetType: body.targetType,
      targetId: body.targetId,
      projectId: body.projectId ?? null,
      info: body.info ?? {},
      ipAddress: body.ipAddress,
      userAgent: body.userAgent,
    });
    res.sendStatus(201);
  }),
};

export default AuditLogController;
