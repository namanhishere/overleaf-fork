import Settings from "@overleaf/settings";
import { db, ObjectId } from "../../infrastructure/mongodb.mjs";
import SessionManager from "../Authentication/SessionManager.mjs";
import { expressify } from "@overleaf/promise-utils";
import { z, zz, parseReq } from "../../infrastructure/Validation.mjs";
import UserGetter from "../User/UserGetter.mjs";
import UserUpdater from "../User/UserUpdater.mjs";
import UserDeleter from "../User/UserDeleter.mjs";
import AuthenticationManager from "../Authentication/AuthenticationManager.mjs";
import AuditLogManager from "../Audit/AuditLogManager.mjs";
import RedisWrapper from "../../infrastructure/RedisWrapper.mjs";

const suspendedUsersClient = RedisWrapper.client("suspended_users");
const MIN_PASSWORD_LENGTH = Settings.passwordStrengthOptions?.length?.min || 8;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function _setSuspendedFlag(userId, suspended) {
  if (suspended) {
    await suspendedUsersClient.sadd("suspended_users", String(userId));
  } else {
    await suspendedUsersClient.srem("suspended_users", String(userId));
  }
}

function _initiatorId(req) {
  return SessionManager.getLoggedInUserId(req.session);
}

const listUsersSchema = z.object({
  query: z.object({
    q: z.string().trim().max(200).optional().default(""),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
});

const getUserSchema = z.object({
  params: z.object({ userId: zz.objectId() }),
});

const patchUserSchema = z.object({
  params: z.object({ userId: zz.objectId() }),
  body: z.object({
    isAdmin: z.boolean().optional(),
    suspended: z.boolean().optional(),
    suspendedReason: z.string().max(500).optional(),
  }),
});

const passwordSchema = z.object({
  params: z.object({ userId: zz.objectId() }),
  body: z.object({
    newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(128),
  }),
});

const deleteUserSchema = z.object({
  params: z.object({ userId: zz.objectId() }),
  query: z.object({ confirm: z.string() }),
});

// GET /admin/api/users/search?q=&limit=&offset=
async function searchUsers(req, res) {
  const { q, limit = 20, offset = 0 } = parseReq(req, listUsersSchema).query;
  const criteria = q
    ? {
        $or: [
          { email: new RegExp(escapeRegex(q), "i") },
          { first_name: new RegExp(escapeRegex(q), "i") },
          { last_name: new RegExp(escapeRegex(q), "i") },
        ],
      }
    : {};
  const [users, total] = await Promise.all([
    db.users
      .find(criteria, {
        projection: { hashedPassword: 0, twoFactorAuthentication: 0 },
      })
      .sort({ email: 1 })
      .skip(offset)
      .limit(limit)
      .toArray(),
    db.users.countDocuments(criteria),
  ]);
  res.json({ users, total, limit, offset });
}

// GET /admin/users/:userId
async function getUser(req, res) {
  const { userId } = parseReq(req, getUserSchema).params;
  const user = await UserGetter.promises.getUser(userId, {
    hashedPassword: 0,
    twoFactorAuthentication: 0,
  });
  if (!user) {
    return res.status(404).json({ error: "user not found" });
  }
  const oid = new ObjectId(String(user._id));
  const projectCount = await db.projects.countDocuments({
    $or: [
      { owner_ref: oid },
      { collaberator_refs: oid },
      { readOnly_refs: oid },
      { reviewer_refs: oid },
    ],
  });
  res.json({ user, projectCount });
}

// PATCH /admin/users/:userId  { isAdmin?, suspended?, suspendedReason? }
async function patchUser(req, res) {
  const { params, body } = parseReq(req, patchUserSchema);
  const userId = params.userId;
  const user = await UserGetter.promises.getUser(userId, {
    isAdmin: 1,
    suspended: 1,
    email: 1,
  });
  if (!user) {
    return res.status(404).json({ error: "user not found" });
  }
  const initiatorId = _initiatorId(req);
  const ipAddress = req.ip;

  if (body.isAdmin != null && body.isAdmin !== Boolean(user.isAdmin)) {
    await UserUpdater.promises.updateUser(userId, {
      $set: { isAdmin: body.isAdmin },
    });
    await AuditLogManager.promises.recordAudit({
      actorId: initiatorId,
      action: "user-set-admin",
      targetType: "user",
      targetId: String(userId),
      info: {
        before: { isAdmin: !!user.isAdmin },
        after: { isAdmin: body.isAdmin },
      },
      ipAddress,
    });
  }

  if (body.suspended != null && body.suspended !== Boolean(user.suspended)) {
    if (body.suspended) {
      // suspendUser writes its own audit entry ('account-suspension',
      // mirrored into the unified log) and revokes live sessions.
      await UserUpdater.promises.suspendUser(userId, {
        initiatorId,
        ip: ipAddress,
        info: { reason: body.suspendedReason || "suspended by admin" },
      });
    } else {
      await UserUpdater.promises.updateUser(userId, {
        $set: { suspended: false },
      });
      await AuditLogManager.promises.recordAudit({
        actorId: initiatorId,
        action: "user-unsuspend",
        targetType: "user",
        targetId: String(userId),
        info: { before: { suspended: true }, after: { suspended: false } },
        ipAddress,
      });
    }
    await _setSuspendedFlag(userId, body.suspended);
  }

  res.json({ ok: true });
}

// POST /admin/users/:userId/password  { newPassword }
async function setPassword(req, res) {
  const { params, body } = parseReq(req, passwordSchema);
  const userId = params.userId;
  const user = await UserGetter.promises.getUser(userId, { email: 1 });
  if (!user) {
    return res.status(404).json({ error: "user not found" });
  }
  await AuthenticationManager.promises.setUserPassword(user, body.newPassword);
  await UserUpdater.promises.updateUser(userId, {
    $set: { must_reset_password: false },
  });
  await AuditLogManager.promises.recordAudit({
    actorId: _initiatorId(req),
    action: "admin-password-change",
    targetType: "user",
    targetId: String(userId),
    info: {},
    ipAddress: req.ip,
  });
  res.json({ ok: true });
}

// DELETE /admin/users/:userId?confirm=<email>
async function deleteUser(req, res) {
  const { params, query } = parseReq(req, deleteUserSchema);
  const userId = params.userId;
  const user = await UserGetter.promises.getUser(userId, { email: 1 });
  if (!user) {
    return res.status(404).json({ error: "user not found" });
  }
  if (query.confirm !== user.email) {
    return res
      .status(400)
      .json({ error: "confirm parameter must match the user's email" });
  }
  res.json({ ok: true, deleting: true });
  try {
    await UserDeleter.promises.deleteUser(userId);
    await _setSuspendedFlag(userId, false);
  } finally {
    await AuditLogManager.promises
      .recordAudit({
        actorId: _initiatorId(req),
        action: "admin-delete-user",
        targetType: "user",
        targetId: String(userId),
        info: { email: user.email },
        ipAddress: req.ip,
      })
      .catch(() => {});
  }
}

export default {
  searchUsers: expressify(searchUsers),
  getUser: expressify(getUser),
  patchUser: expressify(patchUser),
  setPassword: expressify(setPassword),
  deleteUser: expressify(deleteUser),
};
