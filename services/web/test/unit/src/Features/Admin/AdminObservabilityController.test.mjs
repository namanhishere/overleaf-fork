import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Admin/AdminObservabilityController.mjs",
);

describe("AdminObservabilityController", function () {
  beforeEach(async function (ctx) {
    ctx.CompileJob = {
      aggregate: sinon.stub().returns({ exec: sinon.stub().resolves([]) }),
    };
    ctx.User = {
      countDocuments: sinon.stub().resolves(7),
    };
    ctx.AuditEntry = {
      countDocuments: sinon.stub().resolves(12),
    };
    ctx.rclient = {
      xpending: sinon.stub().resolves([3, "0"]),
      xlen: sinon.stub().resolves(1),
      get: sinon.stub().resolves(
        JSON.stringify({
          checkedAt: "2026-01-01T00:00:00Z",
          workers: [{ id: "clsi-0", ok: true }],
        }),
      ),
    };

    vi.doMock("../../../../../app/src/models/CompileJob.mjs", () => ({
      CompileJob: ctx.CompileJob,
    }));
    vi.doMock("../../../../../app/src/models/User.mjs", () => ({
      User: ctx.User,
    }));
    vi.doMock("../../../../../app/src/models/AuditEntry.mjs", () => ({
      AuditEntry: ctx.AuditEntry,
    }));
    vi.doMock("../../../../../app/src/infrastructure/RedisWrapper.mjs", () => ({
      default: { client: () => ctx.rclient },
    }));

    ctx.controller = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.resetModules();
  });

  it("aggregates compile outcomes, users, queue and workers", async function (ctx) {
    ctx.CompileJob.aggregate.returns({
      exec: sinon.stub().resolves([
        { _id: "success", count: 8, avgRuntimeMs: 400 },
        { _id: "failed", count: 2, avgRuntimeMs: 100 },
      ]),
    });
    ctx.User.countDocuments.withArgs({ isAdmin: true }).resolves(2);
    ctx.User.countDocuments.withArgs({ suspended: true }).resolves(1);

    const res = { json: sinon.stub() };
    await ctx.controller.getObservability({}, res);

    const body = res.json.firstCall.args[0];
    expect(body.compiles.total).to.equal(10);
    expect(body.compiles.byStatus).to.deep.equal({ success: 8, failed: 2 });
    // 8*400 + 2*100 = 3400 / 10 = 340
    expect(body.compiles.avgRuntimeMs).to.equal(340);
    // failure rate = 2/10 = 20%
    expect(body.compiles.failureRate).to.equal(20);
    expect(body.users).to.deep.equal({ total: 7, admins: 2, suspended: 1 });
    expect(body.auditEntries).to.equal(12);
    expect(body.queue).to.deep.equal({ pending: 3, dlq: 1 });
    expect(body.workers.workers[0].id).to.equal("clsi-0");
    // aggregation window is 24h
    const match = ctx.CompileJob.aggregate.firstCall.args[0][0].$match;
    expect(match.queuedAt.$gte).to.be.an.instanceOf(Date);
  });

  it("degrades gracefully when redis is unavailable", async function (ctx) {
    ctx.rclient.xpending.rejects(new Error("down"));
    ctx.rclient.get.rejects(new Error("down"));

    const res = { json: sinon.stub() };
    await ctx.controller.getObservability({}, res);

    const body = res.json.firstCall.args[0];
    expect(body.queue.pending).to.be.null;
    expect(body.workers).to.be.null;
    expect(body.compiles.total).to.equal(0);
    expect(body.compiles.failureRate).to.be.null;
  });
});
