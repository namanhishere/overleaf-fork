import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Admin/AdminWorkersController.mjs",
);

describe("AdminWorkersController", function () {
  beforeEach(async function (ctx) {
    ctx.healthResult = {
      checkedAt: "2026-08-29T00:00:00Z",
      workers: [{ id: "clsi-0", url: "http://clsi:3013", ok: true }],
    };
    ctx.registry = {
      getWorker: sinon.stub(),
      invalidatePinCache: sinon.stub(),
      promises: {
        getWorkerHealth: sinon.stub().resolves(ctx.healthResult),
      },
    };
    ctx.projectUpdate = { exec: sinon.stub().resolves() };
    ctx.Project = { updateOne: sinon.stub().returns(ctx.projectUpdate) };
    ctx.recordAudit = sinon.stub().resolves();

    vi.doMock(
      "../../../../../app/src/Features/Compile/WorkerRegistry.mjs",
      () => ({ default: ctx.registry }),
    );
    vi.doMock("../../../../../app/src/infrastructure/mongodb.mjs", () => ({
      ObjectId: class FakeObjectId {
        constructor(value) {
          this.value = value;
        }
      },
    }));
    vi.doMock("../../../../../app/src/models/Project.mjs", () => ({
      Project: ctx.Project,
    }));
    vi.doMock("../../../../../app/src/Features/Audit/AuditLogManager.mjs", () => ({
      default: {
        promises: { recordAudit: ctx.recordAudit },
      },
    }));
    vi.doMock(
      "../../../../../app/src/Features/Authentication/SessionManager.mjs",
      () => ({
        default: { getLoggedInUserId: sinon.stub().returns("user-1") },
      }),
    );

    ctx.controller = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.resetModules();
  });

  it("serves the shared worker health result from the registry", async function (ctx) {
    const res = { json: sinon.stub() };
    await ctx.controller.listWorkers({}, res);

    expect(ctx.registry.promises.getWorkerHealth).to.have.been.calledOnce;
    expect(res.json.firstCall.args[0]).to.deep.equal(ctx.healthResult);
  });

  it("rejects a pin request without a valid projectId", async function (ctx) {
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
    };
    await ctx.controller.pinWorker(
      { body: { projectId: "nope", workerId: "clsi-0" }, session: {} },
      res,
    );

    expect(res.status).to.have.been.calledWith(400);
    expect(ctx.Project.updateOne).not.to.have.been.called;
  });

  it("rejects a pin request for an unknown worker", async function (ctx) {
    ctx.registry.getWorker.returns(null);
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
    };
    await ctx.controller.pinWorker(
      {
        body: { projectId: "aaaaaaaaaaaaaaaaaaaaaaaa", workerId: "ghost" },
        session: {},
      },
      res,
    );

    expect(res.status).to.have.been.calledWith(400);
    expect(ctx.Project.updateOne).not.to.have.been.called;
  });

  it("pins a project to a worker and records an audit entry", async function (ctx) {
    ctx.registry.getWorker.returns({ id: "worker-01", url: "http://w1:3013" });
    const res = { json: sinon.stub() };
    await ctx.controller.pinWorker(
      {
        body: { projectId: "aaaaaaaaaaaaaaaaaaaaaaaa", workerId: "worker-01" },
        session: {},
      },
      res,
    );

    expect(ctx.Project.updateOne).to.have.been.calledWith(
      { _id: sinon.match({ value: "aaaaaaaaaaaaaaaaaaaaaaaa" }) },
      { $set: { compileWorkerId: "worker-01" } },
    );
    expect(ctx.projectUpdate.exec).to.have.been.calledOnce;
    expect(ctx.registry.invalidatePinCache).to.have.been.calledWith(
      "aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(ctx.recordAudit).to.have.been.calledWith(
      sinon.match({
        actorId: "user-1",
        action: "worker-pin-set",
        targetType: "project",
        info: { workerId: "worker-01" },
      }),
    );
    expect(res.json.firstCall.args[0]).to.deep.equal({
      ok: true,
      projectId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      workerId: "worker-01",
    });
  });
});
