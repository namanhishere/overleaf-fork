import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import mongodb, { db, getDb, getCollectionInternal } from "../../infrastructure/mongodb.mjs";
import logger from "@overleaf/logger";
import OError from "@overleaf/o-error";

const BACKUP_DIR =
  process.env.OVERLEAF_BACKUP_DIR || "/tmp/overleaf-backups";
// System collections that must never be dumped or restored.
const SKIP_COLLECTIONS = new Set(["migrations"]);
const RESTORE_TEST_DB = "sharelatex_restore_test";

let running = false;

function runDir(runId) {
  return path.join(BACKUP_DIR, runId);
}

function newRunId() {
  return `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto
    .randomBytes(3)
    .toString("hex")}`;
}

/**
 * Logical backup: every user collection is streamed to
 * <backupDir>/<runId>/mongo/<name>.json.gz (one JSON document per line),
 * with a manifest.json describing the run. Binary mongodump remains the
 * recommended production path for very large datasets; this logical form
 * is portable, human-inspectable and restorable into any target db.
 */
async function runBackup({ label = "" } = {}) {
  if (running) {
    throw new OError("a backup is already running");
  }
  running = true;
  const runId = newRunId();
  const record = {
    runId,
    label: String(label).slice(0, 200),
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
    collections: [],
    error: null,
    restoreTest: null,
  };
  const coll = db.backupRuns;
  try {
    fs.mkdirSync(path.join(runDir(runId), "mongo"), { recursive: true });
    const names = (await mongodb.getCollectionNames()).filter(
      n => !n.startsWith("system.") && !SKIP_COLLECTIONS.has(n),
    );
    for (const name of names.sort()) {
      const file = path.join(runDir(runId), "mongo", `${name}.json.gz`);
      const count = await dumpCollection(name, file);
      const sizeBytes = fs.statSync(file).size;
      record.collections.push({ name, count, file: `mongo/${name}.json.gz`, sizeBytes });
    }
    record.status = "complete";
    record.finishedAt = new Date();
    fs.writeFileSync(
      path.join(runDir(runId), "manifest.json"),
      JSON.stringify(record, null, 2),
    );
    await coll.insertOne({ ...record });
    logger.info({ runId }, "backup completed");
    return { ...record };
  } catch (err) {
    record.status = "failed";
    record.error = String(err?.message || err).slice(0, 500);
    record.finishedAt = new Date();
    try {
      await coll.insertOne({ ...record });
    } catch {
      // best effort
    }
    logger.error({ err, runId }, "backup failed");
    throw OError.tag(err, "backup failed", { runId });
  } finally {
    running = false;
  }
}

function dumpCollection(name, file) {
  return new Promise(async (resolve, reject) => {
    const gz = zlib.createGzip();
    const out = fs.createWriteStream(file);
    gz.pipe(out);
    let count = 0;
    const cursor = (await getCollectionInternal(name)).find({}).batchSize(500);
    const pump = async () => {
      while (true) {
        const docs = [];
        while (docs.length < 500 && (docs.length === 0 || (await cursor.hasNext()))) {
          if (docs.length > 0 && !(await cursor.hasNext())) break;
          const doc = await cursor.next();
          if (doc == null) break;
          docs.push(doc);
        }
        if (docs.length === 0) break;
        const lines = docs.map(d => JSON.stringify(d)).join("\n") + "\n";
        if (!gz.write(lines)) {
          await new Promise(r => gz.once("drain", r));
        }
        count += docs.length;
      }
      gz.end();
    };
    pump().catch(err => {
      gz.destroy(err);
    });
    out.on("error", reject);
    gz.on("error", reject);
    out.on("finish", () => resolve(count));
  });
}

async function listBackups({ limit = 50 } = {}) {
  const runs = await db.backupRuns
    .find({})
    .sort({ startedAt: -1 })
    .limit(Math.min(limit, 200))
    .toArray();
  // annotate with on-disk presence
  return runs.map(r => ({
    ...r,
    onDisk: fs.existsSync(runDir(r.runId)),
  }));
}

async function getBackup(runId) {
  const run = await db.backupRuns.findOne({ runId });
  if (run == null) return null;
  return { ...run, onDisk: fs.existsSync(runDir(runId)) };
}

function readCollectionFile(runId, collectionName) {
  // path traversal guard: collectionName must be a bare name
  if (!/^[A-Za-z0-9_-]+$/.test(collectionName)) {
    throw new OError("invalid collection name");
  }
  const file = path.join(runDir(runId), "mongo", `${collectionName}.json.gz`);
  if (!fs.existsSync(file)) {
    throw new OError("collection backup file not found");
  }
  return file;
}

/**
 * Restore a backup into a target database (default: a scratch db used for
 * restore testing). Documents are replaced per collection; counts are
 * verified against the manifest.
 */
async function restoreBackup(runId, { targetDb = RESTORE_TEST_DB } = {}) {
  const run = await getBackup(runId);
  if (run == null) throw new OError("backup not found", { runId });
  if (run.status !== "complete") {
    throw new OError("backup is not complete", { runId, status: run.status });
  }
  const target = getDb(targetDb);
  const results = [];
  for (const entry of run.collections) {
    const file = readCollectionFile(runId, entry.name);
    const lines = zlib
      .gunzipSync(fs.readFileSync(file))
      .toString()
      .split("\n")
      .filter(l => l.trim());
    const coll = target.collection(entry.name);
    await coll.deleteMany({});
    if (lines.length > 0) {
      const docs = lines.map(l => JSON.parse(l));
      // chunk inserts to stay under limits
      for (let i = 0; i < docs.length; i += 500) {
        await coll.insertMany(docs.slice(i, i + 500));
      }
    }
    const restored = await coll.countDocuments({});
    results.push({
      name: entry.name,
      expected: entry.count,
      restored,
      ok: restored === entry.count,
    });
  }
  const ok = results.every(r => r.ok);
  await db.backupRuns.updateOne(
    { runId },
    {
      $set: {
        restoreTest: {
          at: new Date(),
          targetDb,
          ok,
          results,
        },
      },
    },
  );
  return { ok, targetDb, results };
}

export default {
  runBackup,
  listBackups,
  getBackup,
  restoreBackup,
  readCollectionFile,
  BACKUP_DIR,
  RESTORE_TEST_DB,
  promises: {
    runBackup,
    listBackups,
    getBackup,
    restoreBackup,
    readCollectionFile,
  },
};
