import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Audit/AuditLogManager.mjs",
);

describe("AuditLogManager", function () {
  beforeEach(async function (ctx) {
    ctx.clock = sinon.useFakeTimers();

    ctx.AuditEntry = {
      create: sinon.stub().resolves({}),
      find: sinon.stub(),
      countDocuments: sinon.stub().resolves(0),
    };
    ctx.AuditEntry.find.returns({
      sort: sinon.stub().returnsThis(),
      skip: sinon.stub().returnsThis(),
      limit: sinon.stub().returnsThis(),
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves([]),
    });

    vi.doMock(
      "../../../../../app/src/models/AuditEntry.mjs",
      () => ({
        AuditEntry: ctx.AuditEntry,
      }),
      { default: false },
    );
    vi.doMock("../../../../../app/src/infrastructure/mongodb.mjs", () => ({
      ObjectId: class FakeObjectId {
        constructor(value) {
          this.value = value;
        }
        toString() {
          return this.value;
        }
      },
    }));

    ctx.AuditLogManager = (await import(modulePath)).default;
  });

  afterEach(function (ctx) {
    ctx.clock.restore();
    vi.resetModules();
  });

  describe("recordAudit", function () {
    it("writes an entry with defaults", async function (ctx) {
      await ctx.AuditLogManager.promises.recordAudit({
        action: "user-suspend",
        targetType: "user",
        targetId: "abc123",
      });
      expect(ctx.AuditEntry.create).to.have.been.calledOnce;
      const entry = ctx.AuditEntry.create.firstCall.args[0];
      expect(entry.action).to.equal("user-suspend");
      expect(entry.targetType).to.equal("user");
      expect(entry.targetId).to.equal("abc123");
      expect(entry.actorType).to.equal("user");
      expect(entry.actorId).to.be.null;
      expect(entry.timestamp).to.deep.equal(new Date());
    });

    it("derives ip and user agent from the request", async function (ctx) {
      await ctx.AuditLogManager.promises.recordAudit({
        action: "x",
        targetType: "project",
        targetId: "p1",
        req: { ip: "10.0.0.1", headers: { "user-agent": "test-agent" } },
      });
      const entry = ctx.AuditEntry.create.firstCall.args[0];
      expect(entry.ipAddress).to.equal("10.0.0.1");
      expect(entry.userAgent).to.equal("test-agent");
    });

    it("rejects missing action", async function (ctx) {
      await expect(
        ctx.AuditLogManager.promises.recordAudit({
          targetType: "user",
          targetId: "u1",
        }),
      ).to.be.rejected;
    });

    it("swallows write failures after retry instead of throwing", async function (ctx) {
      ctx.AuditEntry.create.rejects(new Error("mongo down"));
      await ctx.AuditLogManager.promises.recordAudit({
        action: "a",
        targetType: "user",
        targetId: "u2",
      });
      // one initial write + one retry
      expect(ctx.AuditEntry.create).to.have.been.calledTwice;
    });
  });

  describe("query", function () {
    it("applies filters and pagination bounds", async function (ctx) {
      ctx.AuditEntry.countDocuments.resolves(3);
      await ctx.AuditLogManager.promises.query({
        targetType: "user",
        targetId: "u9",
        actorId: "507f1f77bcf86cd799439011",
        limit: 10000,
        offset: -5,
      });
      expect(ctx.AuditEntry.find.firstCall.args[0]).to.deep.equal({
        targetType: "user",
        targetId: "u9",
        actorId: { value: "507f1f77bcf86cd799439011" },
      });
      expect(ctx.AuditEntry.countDocuments.firstCall.args[0]).to.deep.equal(
        ctx.AuditEntry.find.firstCall.args[0],
      );
    });
    it("matches action as a case-insensitive substring", async function (ctx) {
      await ctx.AuditLogManager.promises.query({ action: "Kill" });
      const criteria = ctx.AuditEntry.find.firstCall.args[0];
      expect(criteria.action.$options).to.equal("i");
      expect(criteria.action.$regex).to.equal("Kill");
    });
  });
});
