import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Compile/CompileJobManager.mjs",
);

describe("CompileJobManager", function () {
  beforeEach(async function (ctx) {
    ctx.CompileJob = {
      create: sinon.stub().callsFake(async (doc) => doc),
      updateOne: sinon.stub().returns({ exec: sinon.stub().resolves({}) }),
      find: sinon.stub(),
      findOne: sinon.stub(),
    };

    ctx.rclient = {
      scard: sinon.stub().resolves(0),
      sadd: sinon.stub().resolves(1),
      srem: sinon.stub().resolves(1),
      xadd: sinon.stub().resolves("1-1"),
      xgroup: sinon.stub().resolves(),
      xreadgroup: sinon.stub().resolves([["jobs:stream", []]]),
      xautoclaim: sinon.stub().resolves(["0", []]),
      xack: sinon.stub().resolves(1),
    };

    vi.doMock("../../../../../app/src/models/CompileJob.mjs", () => ({
      CompileJob: ctx.CompileJob,
    }));
    vi.doMock("../../../../../app/src/infrastructure/RedisWrapper.mjs", () => ({
      default: { client: () => ctx.rclient },
    }));
    vi.doMock("@overleaf/job-queue", () => ({
      enqueue: (client, stream, job) =>
        client.xadd(
          stream,
          "*",
          "type",
          String(job.type || ""),
          "priority",
          String(job.priority || 0),
          "payload",
          JSON.stringify(job.payload ?? {}),
        ),
      Consumer: class {
        constructor() {}
        async run() {}
        stop() {}
      },
    }));
    vi.doMock("@overleaf/settings", () => ({
      default: { compileConcurrencyLimits: { perUser: 3, perProject: 1 } },
    }));

    ctx.CompileJobManager = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.resetModules();
  });

  describe("acquireAllSlots", function () {
    it("adds the job to both user and project slot sets", async function (ctx) {
      await ctx.CompileJobManager.acquireAllSlots("u1", "p1", "j1");
      expect(ctx.rclient.sadd.getCall(0).args).to.deep.equal([
        "activeCompiles:p:p1",
        "j1",
      ]);
      expect(ctx.rclient.sadd.getCall(1).args).to.deep.equal([
        "activeCompiles:u:u1",
        "j1",
      ]);
    });

    it("throws CompileLimitReachedError when the project cap is hit", async function (ctx) {
      ctx.rclient.scard.resolves(1); // perProject cap is 1
      await expect(
        ctx.CompileJobManager.acquireAllSlots("u1", "p1", "j1"),
      ).to.be.rejectedWith(ctx.CompileJobManager.CompileLimitReachedError);
      // nothing was added
      expect(ctx.rclient.sadd.notCalled).to.be.true;
    });

    it("releases the project slot when the user cap rejects", async function (ctx) {
      ctx.rclient.scard.onFirstCall().resolves(0);
      ctx.rclient.scard.onSecondCall().resolves(3); // perUser cap is 3
      await expect(ctx.CompileJobManager.acquireAllSlots("u1", "p1", "j1")).to
        .be.rejected;
      expect(ctx.rclient.srem.firstCall.args).to.deep.equal([
        "activeCompiles:p:p1",
        "j1",
      ]);
    });
  });

  describe("startJob", function () {
    it("creates a queued job record without enqueueing", async function (ctx) {
      const job = await ctx.CompileJobManager.startJob({
        jobId: "job-123",
        projectId: "p1",
        userId: "u1",
        compiler: "pdflatex",
        timeoutMs: 60000,
      });
      expect(job.jobId).to.equal("job-123");
      expect(job.status).to.equal("queued");
      // Enqueueing moved to dispatch(); the row alone must not hit the stream.
      expect(ctx.rclient.xadd.called).to.be.false;
    });
  });

  describe("reapStaleJobs", function () {
    it("times out active rows older than the cutoff", async function (ctx) {
      ctx.CompileJob.updateMany = sinon
        .stub()
        .returns({ exec: sinon.stub().resolves({ modifiedCount: 2 }) });
      const n = await ctx.CompileJobManager.reapStaleJobs(1_000_000);
      expect(n).to.equal(2);
      const [criteria, update] = ctx.CompileJob.updateMany.firstCall.args;
      expect(criteria.status).to.deep.equal({ $in: ["queued", "running"] });
      expect(criteria.queuedAt.$lt).to.be.an.instanceOf(Date);
      expect(update.status).to.equal("timeout");
    });
  });

  describe("finishJob", function () {
    it("only finalizes rows still in an active state", async function (ctx) {
      await ctx.CompileJobManager.finishJob("j9", {
        status: "success",
        stats: { runtimeMs: 500, peakCpuPercent: 80 },
      });
      const [criteria, update] = ctx.CompileJob.updateOne.firstCall.args;
      expect(criteria).to.deep.equal({
        jobId: "j9",
        status: { $in: ["queued", "running"] },
      });
      expect(update.status).to.equal("success");
      expect(update.runtimeMs).to.equal(500);
      expect(update.finishedAt).to.exist;
    });

    it("records error text without throwing on long messages", async function (ctx) {
      await ctx.CompileJobManager.finishJob("j9", {
        status: "failed",
        error: new Error("x".repeat(1000)),
      });
      const [, update] = ctx.CompileJob.updateOne.firstCall.args;
      expect(update.error.length).to.be.at.most(500);
    });

    it("merges worker telemetry from the Redis hash", async function (ctx) {
      ctx.rclient.hgetall = sinon.stub().resolves({
        runtimeMs: "364",
        peakCpuPercent: "82",
        peakRssBytes: "4661248",
        pid: "53",
        workerId: "clsi-0",
        logExcerpt: "latexmk: done",
      });
      await ctx.CompileJobManager.finishJob("j-tel", { status: "success" });
      const [, update] = ctx.CompileJob.updateOne.lastCall.args;
      expect(update.runtimeMs).to.equal(364);
      expect(update.peakCpuPercent).to.equal(82);
      expect(update.peakRssBytes).to.equal(4661248);
      expect(update.pid).to.equal(53);
      expect(update.workerId).to.equal("clsi-0");
      expect(update.logExcerpt).to.equal("latexmk: done");
    });

    it("lets explicit stats win over telemetry", async function (ctx) {
      ctx.rclient.hgetall = sinon
        .stub()
        .resolves({ runtimeMs: "364", peakCpuPercent: "82" });
      await ctx.CompileJobManager.finishJob("j-win", {
        status: "success",
        stats: { runtimeMs: 999 },
      });
      const [, update] = ctx.CompileJob.updateOne.lastCall.args;
      expect(update.runtimeMs).to.equal(999);
      expect(update.peakCpuPercent).to.equal(82);
    });
   });

  describe("cancelActiveJobs", function () {
    it("cancels all active jobs of a project", async function (ctx) {
      ctx.CompileJob.find.returns({
        lean: sinon.stub().returns({
          exec: sinon.stub().resolves([
            { jobId: "a", status: "running" },
            { jobId: "b", status: "queued" },
          ]),
        }),
      });
      const cancelled = await ctx.CompileJobManager.cancelActiveJobs(
        "p1",
        "killed by admin",
      );
      expect(cancelled).to.deep.equal(["a", "b"]);
      expect(ctx.CompileJob.find.firstCall.args[0]).to.deep.equal({
        projectId: "p1",
        status: { $in: ["queued", "running"] },
      });
      expect(ctx.CompileJob.updateOne.calledTwice).to.be.true;
    });
  });

  describe("dispatch", function () {
    it("runs the executor once the queue hands the job back", async function (ctx) {
      let consumerHandler = null;
      vi.doMock("@overleaf/job-queue", () => ({
        enqueue: sinon.stub().resolves(),
        Consumer: class {
          constructor() {}
          run(handler) {
            consumerHandler = handler;
            return Promise.resolve();
          }
          stop() {}
        },
      }));
      vi.resetModules();
      ctx.CompileJobManager = (await import(modulePath)).default;

      const executor = sinon.stub().resolves({ ok: true });
      const promise = ctx.CompileJobManager.dispatch(
        { jobId: "j-dispatch", priority: 0 },
        executor,
      );

      // give startConsumer's fire-and-forget run() a tick to register
      await new Promise((resolve) => setTimeout(resolve, 10));
      await consumerHandler({ jobId: "j-dispatch" });
      const result = await promise;
      expect(result).to.deep.equal({ ok: true });
      expect(executor.calledOnce).to.be.true;
    });

    it("registers the dispatcher before enqueueing (no dispatch-loss race)", async function (ctx) {
      let consumerHandler = null;
      // enqueue resolves synchronously; a live consumer could observe the
      // message during the await. The handler must already be registered.
      vi.doMock("@overleaf/job-queue", () => ({
        enqueue: async (client, stream, job) => {
          const payload = JSON.parse(
            client.payload ?? JSON.stringify(job.payload),
          );
          if (consumerHandler != null) {
            // Simulate an eager consumer delivering immediately on enqueue.
            setImmediate(() => consumerHandler(payload));
          }
          return "1-1";
        },
        Consumer: class {
          run(handler) {
            consumerHandler = handler;
            return Promise.resolve();
          }
          stop() {}
        },
      }));
      vi.resetModules();
      ctx.CompileJobManager = (await import(modulePath)).default;

      const executor = sinon.stub().resolves({ ok: true });
      const result = await ctx.CompileJobManager.dispatch(
        { jobId: "j-race", priority: 3 },
        executor,
      );
      expect(result).to.deep.equal({ ok: true });
      expect(executor.calledOnce).to.be.true;
    });

    it("fails the durable row when no dispatcher is registered", async function (ctx) {
      let consumerHandler = null;
      vi.doMock("@overleaf/job-queue", () => ({
        enqueue: sinon.stub().resolves(),
        Consumer: class {
          run(handler) {
            consumerHandler = handler;
            return Promise.resolve();
          }
          stop() {}
        },
      }));
      vi.resetModules();
      ctx.CompileJobManager = (await import(modulePath)).default;

      // Start (but do not await) one dispatch to spin up the consumer,
      // then resolve it so pendingDispatches is empty again.
      const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
      const seed = ctx.CompileJobManager.dispatch(
        { jobId: "seed", priority: 0 },
        () => {},
      );
      await tick();
      consumerHandler({ jobId: "seed" });
      await seed;
      consumerHandler({ jobId: "orphan-1" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const [criteria, update] =
        ctx.CompileJob.updateOne.lastCall.args;
      expect(criteria.jobId).to.equal("orphan-1");
      expect(update.status).to.equal("failed");
    });
  });
});
