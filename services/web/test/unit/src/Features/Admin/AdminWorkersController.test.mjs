import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Admin/AdminWorkersController.mjs",
);

describe("AdminWorkersController", function () {
  beforeEach(async function (ctx) {
    ctx.rclient = {
      get: sinon.stub(),
      set: sinon.stub().resolves("OK"),
    };
    ctx.registry = {
      configuredWorkers: sinon.stub().returns([]),
      getWorker: sinon.stub(),
      invalidatePinCache: sinon.stub(),
    };

    vi.doMock(
      "../../../../../app/src/infrastructure/RedisWrapper.mjs",
      () => ({ default: { client: () => ctx.rclient } }),
    );
    vi.doMock("../../../../../app/src/infrastructure/mongodb.mjs", () => ({
      ObjectId: class FakeObjectId {
        constructor(value) {
          this.value = value;
        }
      },
    }));
    vi.doMock("../../../../../app/src/models/Project.mjs", () => ({
      Project: {
        updateOne: sinon.stub().returns({ exec: sinon.stub().resolves() }),
      },
    }));
    vi.doMock("../../../../../app/src/Features/Audit/AuditLogManager.mjs", () => ({
      default: {
        promises: { recordAudit: sinon.stub().resolves() },
      },
    }));
    vi.doMock(
      "../../../../../app/src/Features/Compile/WorkerRegistry.mjs",
      () => ({ default: ctx.registry }),
    );
    vi.doMock("@overleaf/fetch-utils", () => ({
      fetchJson: sinon.stub(),
    }));
    vi.doMock("@overleaf/settings", () => ({
      default: { apis: { clsi: { url: "http://clsi:3013", workers: [] } } },
    }));

    ctx.controller = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.resetModules();
  });

  it("serves the cached health result without re-probing", async function (ctx) {
    const cached = {
      checkedAt: "2026-08-29T00:00:00Z",
      workers: [{ id: "clsi-0", url: "http://clsi:3013", ok: true }],
    };
    ctx.rclient.get.resolves(JSON.stringify(cached));

    const res = { json: sinon.stub() };
    await ctx.controller.listWorkers({}, res);

    expect(ctx.rclient.get).to.have.been.calledWith("admin:workers:health");
    expect(ctx.rclient.set).not.to.have.been.called;
    expect(res.json.firstCall.args[0]).to.deep.equal(cached);
  });

  it("probes workers and stores the fresh result in the cache on a miss", async function (ctx) {
    ctx.rclient.get.resolves(null);

    const res = { json: sinon.stub() };
    await ctx.controller.listWorkers({}, res);

    const body = res.json.firstCall.args[0];
    expect(body.workers).to.deep.equal([]);
    expect(typeof body.checkedAt).to.equal("string");
    expect(ctx.rclient.set).to.have.been.calledWith(
      "admin:workers:health",
      sinon.match.string,
      "EX",
      15,
    );
    expect(JSON.parse(ctx.rclient.set.firstCall.args[1])).to.deep.equal(body);
  });

  it("re-probes and rewrites the cache when the cached payload is corrupt", async function (ctx) {
    ctx.rclient.get.resolves("not-json{{");

    const res = { json: sinon.stub() };
    await ctx.controller.listWorkers({}, res);

    expect(res.json.firstCall.args[0].workers).to.deep.equal([]);
    expect(ctx.rclient.set).to.have.been.calledWith(
      "admin:workers:health",
      sinon.match.string,
      "EX",
      15,
    );
  });
});
