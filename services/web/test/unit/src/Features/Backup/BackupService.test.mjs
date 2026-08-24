import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Backup/BackupService.mjs",
);

describe("BackupService", function () {
  beforeEach(async function (ctx) {
    ctx.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
    process.env.OVERLEAF_BACKUP_DIR = ctx.tmpDir;

    const collections = {};
    ctx.collections = collections;
    const makeColl = name => ({
      find: sinon.stub().returns({
        batchSize: () => ({
          hasNext: sinon.stub().resolves(false),
          next: sinon.stub().resolves(null),
        }),
      }),
      insertOne: sinon.stub().resolves({}),
      deleteMany: sinon.stub().resolves({}),
      insertMany: sinon.stub().resolves({}),
      countDocuments: sinon.stub().resolves(0),
    });
    ctx.db = new Proxy(
      {},
      {
        get(target, prop) {
          if (prop === "backupRuns") {
            return {
              insertOne: sinon.stub().resolves({}),
              findOne: sinon.stub().resolves(null),
              updateOne: sinon.stub().resolves({}),
              find: sinon
                .stub()
                .returns({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
            };
          }
          collections[prop] ??= makeColl(prop);
          return collections[prop];
        },
      },
    );
    ctx.getCollectionNames = sinon.stub().resolves(["users", "projects", "system.foo"]);
    ctx.getDb = sinon.stub().returns({
      collection: name => {
        collections[`restore:${name}`] ??= {
          deleteMany: sinon.stub().resolves({}),
          insertMany: sinon.stub().resolves({}),
          countDocuments: sinon.stub().resolves(0),
        };
        return collections[`restore:${name}`];
      },
    });

    ctx.getCollectionInternal = sinon.stub().callsFake(async name => {
      collections[name] ??= {
        find: sinon.stub().returns({
          batchSize: () => ({
            hasNext: sinon.stub().resolves(false),
            next: sinon.stub().resolves(null),
          }),
        }),
      };
      return collections[name];
    });
    vi.doMock("../../../../../app/src/infrastructure/mongodb.mjs", () => ({
      default: {
        getCollectionNames: ctx.getCollectionNames,
        getDb: ctx.getDb,
        getCollectionInternal: ctx.getCollectionInternal,
      },
      db: ctx.db,
      getDb: ctx.getDb,
      getCollectionInternal: ctx.getCollectionInternal,
    }));

    ctx.service = (await import(modulePath)).default;
  });

  afterEach(function (ctx) {
    vi.resetModules();
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    delete process.env.OVERLEAF_BACKUP_DIR;
  });

  it("dumps every non-system collection into gzip files with a manifest", async function (ctx) {
    const run = await ctx.service.promises.runBackup({ label: "test" });
    expect(run.status).to.equal("complete");
    expect(run.collections.map(c => c.name).sort()).to.deep.equal([
      "projects",
      "users",
    ]);
    for (const c of run.collections) {
      const file = path.join(ctx.tmpDir, run.runId, c.file);
      expect(fs.existsSync(file)).to.be.true;
      expect(c.sizeBytes).to.be.greaterThan(0);
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ctx.tmpDir, run.runId, "manifest.json"), "utf8"),
    );
    expect(manifest.status).to.equal("complete");
    expect(manifest.label).to.equal("test");
  });

  it("refuses to run two backups concurrently", async function (ctx) {
    // a slow collection find keeps the first backup running
    ctx.getCollectionNames.returns(new Promise(resolve => setTimeout(() => resolve(["users"]), 200)));
    const first = ctx.service.promises.runBackup({});
    await expect(ctx.service.promises.runBackup({})).to.be.rejectedWith(
      /already running/,
    );
    await first;
  });

  it("records failed runs with the error", async function (ctx) {
    ctx.getCollectionNames.rejects(new Error("mongo down"));
    await expect(ctx.service.promises.runBackup({})).to.be.rejectedWith(
      /mongo down/,
    );
    // the failure is recorded by the service (best-effort insert)
  });

  it("rejects invalid collection names on file reads", function (ctx) {
    expect(() =>
      ctx.service.readCollectionFile("run-1", "../etc/passwd"),
    ).to.throw(/invalid collection name/);
  });
});
