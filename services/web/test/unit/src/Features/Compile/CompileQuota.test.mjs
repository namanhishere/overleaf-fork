import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Compile/CompileQuota.mjs",
);

describe("checkCompileQuota", function () {
  beforeEach(async function (ctx) {
    ctx.CompileJob = {
      countDocuments: sinon.stub().resolves(0),
    };
    ctx.User = {
      findOne: sinon.stub().returns({
        lean: sinon.stub().resolves({ isAdmin: false }),
      }),
    };
    vi.doMock("../../../../../app/src/models/CompileJob.mjs", () => ({
      CompileJob: ctx.CompileJob,
    }));
    vi.doMock("../../../../../app/src/models/User.mjs", () => ({
      User: ctx.User,
    }));
    vi.doMock("@overleaf/settings", () => ({
      default: { compileQuotaPerUserPerDay: 5 },
    }));
    ctx.checkCompileQuota = (await import(modulePath)).checkCompileQuota;
  });

  afterEach(function () {
    vi.resetModules();
  });

  it("counts today's jobs and allows under the quota", async function (ctx) {
    ctx.CompileJob.countDocuments.resolves(4);
    const result = await ctx.checkCompileQuota("u1");
    expect(result.ok).to.be.true;
    expect(result.used).to.equal(4);
    expect(result.quota).to.equal(5);
  });

  it("blocks at the quota", async function (ctx) {
    ctx.CompileJob.countDocuments.resolves(5);
    const result = await ctx.checkCompileQuota("u1");
    expect(result.ok).to.be.false;
    expect(result.used).to.equal(5);
    expect(result.quota).to.equal(5);
  });

  it("admins bypass the quota (admin override)", async function (ctx) {
    ctx.User.findOne.returns({
      lean: sinon.stub().resolves({ isAdmin: true }),
    });
    ctx.CompileJob.countDocuments.resolves(999);
    const result = await ctx.checkCompileQuota("u1");
    expect(result.ok).to.be.true;
    expect(result.adminOverride).to.be.true;
    expect(ctx.CompileJob.countDocuments.called).to.be.false;
  });
});
