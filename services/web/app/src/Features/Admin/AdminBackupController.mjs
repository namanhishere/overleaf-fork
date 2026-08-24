import { expressify } from "@overleaf/promise-utils";
import SessionManager from "../Authentication/SessionManager.mjs";
import AuditLogManager from "../Audit/AuditLogManager.mjs";
import BackupService from "../Backup/BackupService.mjs";

function _userId(req) {
  return SessionManager.getLoggedInUserId(req.session);
}

// GET /admin/api/backups
async function listBackups(req, res) {
  const backups = await BackupService.promises.listBackups({});
  res.json({ backups });
}

// POST /admin/api/backups  { label? }
async function runBackup(req, res) {
  try {
    const run = await BackupService.promises.runBackup({
      label: req.body?.label,
    });
    await AuditLogManager.promises.recordAudit({
      actorId: _userId(req),
      action: "backup-run",
      targetType: "settings",
      targetId: run.runId,
      info: {
        after: {
          runId: run.runId,
          collections: run.collections.length,
          status: run.status,
        },
      },
    });
    res.status(201).json({ run });
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("already running")) {
      return res.status(409).json({ error: msg });
    }
    throw err;
  }
}

// POST /admin/api/backups/:runId/restore-test
async function restoreTest(req, res) {
  try {
    const result = await BackupService.promises.restoreBackup(
      req.params.runId,
      {},
    );
    await AuditLogManager.promises.recordAudit({
      actorId: _userId(req),
      action: "backup-restore-test",
      targetType: "settings",
      targetId: req.params.runId,
      info: {
        after: { ok: result.ok, targetDb: result.targetDb },
      },
    });
    res.json(result);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("not found") || msg.includes("not complete")) {
      return res.status(400).json({ error: msg });
    }
    throw err;
  }
}

// GET /admin/api/backups/:runId/file/:collection  — download one collection dump
async function downloadCollection(req, res) {
  try {
    const file = BackupService.readCollectionFile(
      req.params.runId,
      req.params.collection,
    );
    res.download(file, `${req.params.collection}.json.gz`);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("not found") || msg.includes("invalid collection")) {
      return res.status(404).json({ error: msg });
    }
    throw err;
  }
}

export default {
  listBackups: expressify(listBackups),
  runBackup: expressify(runBackup),
  restoreTest: expressify(restoreTest),
  downloadCollection: expressify(downloadCollection),
};
