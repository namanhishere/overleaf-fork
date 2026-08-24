import crypto from "node:crypto";
import OError from "@overleaf/o-error";
import { ProjectSecret } from "../../models/ProjectSecret.mjs";
import AuditLogManager from "../Audit/AuditLogManager.mjs";

const KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ALGO = "aes-256-gcm";

function encryptionKey() {
  const material =
    process.env.OVERLEAF_SECRETS_KEY ||
    process.env.SESSION_SECRET ||
    "overleaf-dev-secrets-fallback";
  return crypto.createHash("sha256").update(material).digest();
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decrypt(stored) {
  const [version, ivB64, tagB64, dataB64] = String(stored).split(":");
  if (version !== "v1") throw new OError("unknown secret version");
  const decipher = crypto.createDecipheriv(
    ALGO,
    encryptionKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * List secret names for a project. Values are never readable through
 * this API — only names and timestamps.
 */
async function listSecrets(projectId) {
  const secrets = await ProjectSecret.find({ projectId })
    .sort({ key: 1 })
    .lean()
    .exec();
  return secrets.map(s => ({
    key: s.key,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    createdBy: s.createdBy,
  }));
}

async function setSecret(projectId, key, value, userId) {
  const cleanKey = String(key || "").trim().toUpperCase();
  if (!KEY_RE.test(cleanKey)) {
    throw new OError("invalid secret key", {
      hint: "uppercase letters, digits and underscores, starting with a letter",
    });
  }
  if (!value || String(value).length === 0) {
    throw new OError("missing secret value");
  }
  const existing = await ProjectSecret.findOne({
    projectId,
    key: cleanKey,
  }).lean();
  await ProjectSecret.updateOne(
    { projectId, key: cleanKey },
    {
      $set: { valueEncrypted: encrypt(String(value)), createdBy: userId },
      $setOnInsert: { projectId, key: cleanKey },
    },
    { upsert: true },
  );
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: existing ? "secret-updated" : "secret-created",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: { key: cleanKey }, // never the value
  });
  return { key: cleanKey, updated: Boolean(existing) };
}

async function deleteSecret(projectId, key, userId) {
  const cleanKey = String(key || "").trim().toUpperCase();
  const res = await ProjectSecret.deleteOne({ projectId, key: cleanKey }).exec();
  if (res.deletedCount === 0) {
    throw new OError("secret not found", { key: cleanKey });
  }
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: "secret-deleted",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: { key: cleanKey },
  });
}

/**
 * Resolve secrets as plaintext key/value pairs — for injection into
 * trusted runtime contexts only (never exposed through any API).
 */
async function resolveSecrets(projectId) {
  const secrets = await ProjectSecret.find({ projectId }).lean().exec();
  const out = {};
  for (const s of secrets) {
    try {
      out[s.key] = decrypt(s.valueEncrypted);
    } catch (err) {
      // a secret that cannot be decrypted (e.g. key rotation) is skipped
    }
  }
  return out;
}

export default {
  listSecrets,
  setSecret,
  deleteSecret,
  resolveSecrets,
  promises: { listSecrets, setSecret, deleteSecret, resolveSecrets },
};
