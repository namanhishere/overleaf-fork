import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Compile/WorkerRegistry.mjs",
);

describe("WorkerRegistry", function () {
  beforeEach(async function (ctx) {
    ctx.ProjectGetter = {
      promises: { getProject: sinon.stub().resolves(null) },
    };
    // Default: an empty cached health payload, so placement tests run
    // without triggering probes. Individual tests override the behavior.
    ctx.rclient = {
      get: sinon.stub().resolves(
        JSON.stringify({ checkedAt: "2026-08-29T00:00:00Z", workers: [] }),
      ),
      set: sinon.stub().resolves("OK"),
    };
    ctx.fetchJson = sinon.stub();

    vi.doMock(
      "../../../../../app/src/Features/Project/ProjectGetter.mjs",
      () => ({ default: ctx.ProjectGetter }),
    );
    vi.doMock(
      "../../../../../app/src/infrastructure/RedisWrapper.mjs",
      () => ({ default: { client: () => ctx.rclient } }),
    );
    vi.doMock("@overleaf/fetch-utils", () => ({ fetchJson: ctx.fetchJson }));
    vi.doMock("@overleaf/settings", () => ({
      default: {
        apis: {
          clsi: {
            url: "http://default-clsi:3013",
            workers: [
              { id: "worker-01", url: "http://worker-01:3013" },
              { id: "worker-02", url: "http://worker-02:3013" },
            ],
          },
        },
      },
    }));
    ctx.registry = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.resetModules();
  });

  it("returns automatic placement for unpinned projects", async function (ctx) {
    ctx.ProjectGetter.promises.getProject.resolves({ compileWorkerId: null });
    const result = await ctx.registry.promises.resolveBaseUrl("p1");
    expect(result.baseUrl).to.equal("http://default-clsi:3013");
    expect(result.workerId).to.be.null;
  });

  it("routes to the pinned worker when set", async function (ctx) {
    ctx.ProjectGetter.promises.getProject.resolves({
      compileWorkerId: "worker-02",
    });
    const result = await ctx.registry.promises.resolveBaseUrl("p1");
    expect(result.baseUrl).to.equal("http://worker-02:3013");
    expect(result.workerId).to.equal("worker-02");
  });

  it("caches the pin lookup", async function (ctx) {
    ctx.ProjectGetter.promises.getProject.resolves({
      compileWorkerId: "worker-01",
    });
    await ctx.registry.promises.resolveBaseUrl("p1");
    await ctx.registry.promises.resolveBaseUrl("p1");
    expect(ctx.ProjectGetter.promises.getProject.calledOnce).to.be.true;
    ctx.registry.invalidatePinCache("p1");
    await ctx.registry.promises.resolveBaseUrl("p1");
    expect(ctx.ProjectGetter.promises.getProject.calledTwice).to.be.true;
  });

  it("falls back to automatic when the pinned worker is unhealthy", async function (ctx) {
    ctx.ProjectGetter.promises.getProject.resolves({
      compileWorkerId: "worker-01",
    });
    const result = await ctx.registry.promises.resolveBaseUrl("p1", {
      "worker-01": { ok: false },
    });
    expect(result.baseUrl).to.equal("http://default-clsi:3013");
    expect(result.workerId).to.be.null;
  });

  it("keeps the pin when the pinned worker is healthy", async function (ctx) {
    ctx.ProjectGetter.promises.getProject.resolves({
      compileWorkerId: "worker-01",
    });
    const result = await ctx.registry.promises.resolveBaseUrl("p1", {
      "worker-01": { ok: true },
    });
    expect(result.workerId).to.equal("worker-01");
  });

  it("treats an unknown worker id as unpinned", async function (ctx) {
    ctx.ProjectGetter.promises.getProject.resolves({
      compileWorkerId: "ghost",
    });
    const result = await ctx.registry.promises.resolveBaseUrl("p1");
    expect(result.baseUrl).to.equal("http://default-clsi:3013");
    expect(result.workerId).to.be.null;
  });

  it("falls back to the default url when mongo lookup fails", async function (ctx) {
    ctx.ProjectGetter.promises.getProject.rejects(new Error("down"));
    const result = await ctx.registry.promises.resolveBaseUrl("p1");
    expect(result.baseUrl).to.equal("http://default-clsi:3013");
    expect(result.workerId).to.be.null;
  });

  describe("compile placement with shared worker health", function () {
    it("skips a pinned worker the shared cache reports unhealthy", async function (ctx) {
      ctx.ProjectGetter.promises.getProject.resolves({
        compileWorkerId: "worker-01",
      });
      ctx.rclient.get.resolves(
        JSON.stringify({
          checkedAt: "2026-08-29T00:00:00Z",
          workers: [{ id: "worker-01", url: "http://worker-01:3013", ok: false }],
        }),
      );

      const result = await ctx.registry.promises.resolveBaseUrl("p1");
      expect(result.baseUrl).to.equal("http://default-clsi:3013");
      expect(result.workerId).to.be.null;
      // served from cache: no probe fan-out on the compile path
      expect(ctx.fetchJson).not.to.have.been.called;
    });

    it("keeps the pin when the shared cache reports the worker healthy", async function (ctx) {
      ctx.ProjectGetter.promises.getProject.resolves({
        compileWorkerId: "worker-01",
      });
      ctx.rclient.get.resolves(
        JSON.stringify({
          checkedAt: "2026-08-29T00:00:00Z",
          workers: [{ id: "worker-01", url: "http://worker-01:3013", ok: true }],
        }),
      );

      const result = await ctx.registry.promises.resolveBaseUrl("p1");
      expect(result.baseUrl).to.equal("http://worker-01:3013");
      expect(result.workerId).to.equal("worker-01");
    });

    it("falls back to the default url when probing the pinned worker fails", async function (ctx) {
      ctx.ProjectGetter.promises.getProject.resolves({
        compileWorkerId: "worker-01",
      });
      // cache miss forces a fresh probe; the worker is unreachable
      ctx.rclient.get.resolves(null);
      ctx.fetchJson.rejects(new Error("ECONNREFUSED"));

      const result = await ctx.registry.promises.resolveBaseUrl("p1");
      expect(ctx.fetchJson).to.have.been.calledWith(
        "http://worker-01:3013/health_details",
        sinon.match.any,
      );
      expect(result.baseUrl).to.equal("http://default-clsi:3013");
      expect(result.workerId).to.be.null;
    });

    it("probes fresh when the cache read fails and honors a healthy pin", async function (ctx) {
      ctx.ProjectGetter.promises.getProject.resolves({
        compileWorkerId: "worker-01",
      });
      ctx.rclient.get.rejects(new Error("redis down"));
      ctx.fetchJson.resolves({ ok: true });

      const result = await ctx.registry.promises.resolveBaseUrl("p1");
      expect(result.baseUrl).to.equal("http://worker-01:3013");
      expect(result.workerId).to.equal("worker-01");
    });

    it("routes to the default url when the whole health subsystem is down", async function (ctx) {
      ctx.ProjectGetter.promises.getProject.resolves({
        compileWorkerId: "worker-01",
      });
      ctx.rclient.get.rejects(new Error("redis down"));
      ctx.fetchJson.rejects(new Error("ECONNREFUSED"));

      // fail-open: no throw, compile still has a target
      const result = await ctx.registry.promises.resolveBaseUrl("p1");
      expect(result.baseUrl).to.equal("http://default-clsi:3013");
      expect(result.workerId).to.be.null;
    });
  });

  describe("getWorkerHealth", function () {
    it("serves the cached payload and does not probe", async function (ctx) {
      const cached = {
        checkedAt: "2026-08-29T00:00:00Z",
        workers: [{ id: "worker-01", url: "http://worker-01:3013", ok: true }],
      };
      ctx.rclient.get.resolves(JSON.stringify(cached));

      const result = await ctx.registry.promises.getWorkerHealth();
      expect(result).to.deep.equal(cached);
      expect(ctx.fetchJson).not.to.have.been.called;
      expect(ctx.rclient.set).not.to.have.been.called;
    });

    it("probes all workers and rewrites the cache on a miss", async function (ctx) {
      ctx.rclient.get.resolves(null);
      ctx.fetchJson.resolves({ ok: true, concurrency: 2, uptimeS: 42 });

      const result = await ctx.registry.promises.getWorkerHealth();

      expect(ctx.fetchJson).to.have.been.calledTwice;
      expect(result.workers).to.deep.equal([
        {
          id: "worker-01",
          url: "http://worker-01:3013",
          ok: true,
          concurrency: 2,
          diskFreePct: null,
          uptimeS: 42,
          versions: {},
        },
        {
          id: "worker-02",
          url: "http://worker-02:3013",
          ok: true,
          concurrency: 2,
          diskFreePct: null,
          uptimeS: 42,
          versions: {},
        },
      ]);
      expect(ctx.rclient.set).to.have.been.calledWith(
        "admin:workers:health",
        sinon.match.string,
        "EX",
        15,
      );
      expect(JSON.parse(ctx.rclient.set.firstCall.args[1])).to.deep.equal(
        result,
      );
    });

    it("reports a failed probe as an unhealthy worker", async function (ctx) {
      ctx.rclient.get.resolves(null);
      ctx.fetchJson.rejects(new Error("ECONNREFUSED"));

      const result = await ctx.registry.promises.getWorkerHealth();

      expect(result.workers).to.deep.equal([
        {
          id: "worker-01",
          url: "http://worker-01:3013",
          ok: false,
          error: "ECONNREFUSED",
        },
        {
          id: "worker-02",
          url: "http://worker-02:3013",
          ok: false,
          error: "ECONNREFUSED",
        },
      ]);
    });
  });
});
