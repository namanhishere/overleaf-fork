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
    vi.doMock(
      "../../../../../app/src/Features/Project/ProjectGetter.mjs",
      () => ({ default: ctx.ProjectGetter }),
    );
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
});
