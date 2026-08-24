import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Review/ReviewService.mjs",
);

const THREADS = {
  t1: {
    resolved: { user_id: "u2" },
    messages: [
      { user_id: "u1", content: "Fix this paragraph", timestamp: "2026-01-02" },
      { user_id: "u2", content: "Done", timestamp: "2026-01-03" },
    ],
  },
  t2: {
    messages: [
      { user_id: "u2", content: "Add methodology section", timestamp: "2026-01-05" },
    ],
  },
};

describe("ReviewService", function () {
  beforeEach(async function (ctx) {
    ctx.ChatApiHandler = {
      promises: {
        getThreads: sinon.stub().resolves(THREADS),
        getResolvedThreadIds: sinon.stub().resolves(["t1"]),
      },
    };
    ctx.ProjectGetter = {
      promises: {
        getProject: sinon.stub().callsFake(async (pid, projection) => {
          if (projection && projection.owner_ref != null) {
            return { owner_ref: "owner-1", reviewers: [] };
          }
          return {
            rootFolder: [{ docs: [], folders: [], fileRefs: [] }],
            owner_ref: "owner-1",
            reviewers: [],
          };
        }),
      },
    };
    ctx.CollaboratorsGetter = {
      promises: { getMemberIds: sinon.stub().resolves(["u2", "u3"]) },
    };
    ctx.UserGetter = {
      promises: {
        getUsers: sinon.stub().callsFake(async ids => {
          const known = {
            u1: { _id: "u1", email: "a@x.io", first_name: "Alice" },
            u2: { _id: "u2", email: "b@x.io", first_name: "Bob" },
            u3: { _id: "u3", email: "c@x.io", first_name: "Carol" },
            "owner-1": { _id: "owner-1", email: "o@x.io", first_name: "Owner" },
          };
          return Array.isArray(ids)
            ? ids.map(id => known[id]).filter(Boolean)
            : [known[ids]].filter(Boolean);
        }),
      },
    };
    ctx.Project = {
      updateOne: sinon.stub().returns({ exec: sinon.stub().resolves({}) }),
    };
    ctx.AuditLogManager = {
      promises: { recordAudit: sinon.stub().resolves() },
    };

    vi.doMock(
      "../../../../../app/src/Features/Chat/ChatApiHandler.mjs",
      () => ({ default: ctx.ChatApiHandler, ChatApiHandler: ctx.ChatApiHandler })
    );
    vi.doMock(
      "../../../../../app/src/Features/Project/ProjectGetter.mjs",
      () => ({ default: ctx.ProjectGetter, ProjectGetter: ctx.ProjectGetter })
    );
    vi.doMock(
      "../../../../../app/src/Features/Collaborators/CollaboratorsGetter.mjs",
      () => ({
        default: ctx.CollaboratorsGetter,
        CollaboratorsGetter: ctx.CollaboratorsGetter,
      })
    );
    vi.doMock("../../../../../app/src/Features/User/UserGetter.mjs", () => ({
      default: ctx.UserGetter,
      UserGetter: ctx.UserGetter,
    }));
    vi.doMock("../../../../../app/src/models/Project.mjs", () => ({
      Project: ctx.Project,
    }));
    vi.doMock(
      "../../../../../app/src/Features/Audit/AuditLogManager.mjs",
      () => ({ default: ctx.AuditLogManager, AuditLogManager: ctx.AuditLogManager })
    );

    ctx.service = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.resetModules();
  });

  describe("getReviewStatus", function () {
    it("summarizes unresolved and resolved counts", async function (ctx) {
      const status = await ctx.service.promises.getReviewStatus("p1");
      expect(status.total).to.equal(2);
      expect(status.unresolved).to.equal(1);
      expect(status.resolved).to.equal(1);
      expect(status.summary).to.match(/1 unresolved comment/);
      expect(status.summary).to.contain("1 resolved");
    });

    it("sorts unresolved threads first", async function (ctx) {
      const status = await ctx.service.promises.getReviewStatus("p1");
      expect(status.threads[0].threadId).to.equal("t2");
      expect(status.threads[0].resolved).to.be.false;
      expect(status.threads[1].resolved).to.be.true;
    });
  });

  describe("addReviewer", function () {
    it("adds a project member as reviewer and audits", async function (ctx) {
      await ctx.service.promises.addReviewer("p1", "u2", "owner-1");
      const arg = ctx.Project.updateOne.firstCall.args;
      expect(arg[1].$addToSet.reviewers).to.equal("u2");
      const audit = ctx.AuditLogManager.promises.recordAudit.lastCall.args[0];
      expect(audit.action).to.equal("reviewer-assigned");
    });

    it("rejects non-members", async function (ctx) {
      await expect(
        ctx.service.promises.addReviewer("p1", "stranger", "owner-1"),
      ).to.be.rejectedWith(/must be a project member/);
      expect(ctx.Project.updateOne.called).to.be.false;
    });

    it("allows the owner as reviewer", async function (ctx) {
      await ctx.service.promises.addReviewer("p1", "owner-1", "owner-1");
      expect(ctx.Project.updateOne.called).to.be.true;
    });
  });

  describe("removeReviewer", function () {
    it("pulls the reviewer and audits", async function (ctx) {
      await ctx.service.promises.removeReviewer("p1", "u2", "owner-1");
      const arg = ctx.Project.updateOne.firstCall.args;
      expect(arg[1].$pull.reviewers).to.equal("u2");
      const audit = ctx.AuditLogManager.promises.recordAudit.lastCall.args[0];
      expect(audit.action).to.equal("reviewer-removed");
    });
  });
});
