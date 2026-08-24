import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/AiAgent/AiAgentService.mjs",
);

describe("AiAgentService", function () {
  beforeEach(async function (ctx) {
    ctx.AiSettings = {
      findOne: sinon.stub().returns({
        lean: sinon.stub().returnsThis(),
        exec: sinon.stub().resolves(null),
      }),
      updateOne: sinon.stub().resolves({}),
    };
    ctx.AiProposalDocs = [];
    ctx.AiProposal = {
      create: sinon.stub().callsFake(async (doc) => {
        // mimic mongoose: apply schema defaults
        const stored = {
          status: "pending",
          createdAt: new Date(),
          resolvedAt: null,
          summary: "",
          previousLines: null,
          userId: null,
          ...doc,
          _id: `prop-${ctx.AiProposalDocs.length + 1}`,
        };
        const doc2 = {
          ...stored,
          toObject: () => ({ ...stored }),
          save: sinon.stub().callsFake(async function () {
            Object.assign(doc2, stored);
          }),
        };
        ctx.AiProposalDocs.push(doc2);
        return doc2;
      }),
      findOne: sinon.stub(),
      find: sinon
        .stub()
        .returns({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
    };
    ctx.ProjectGetter = {
      promises: {
        getProject: sinon.stub().resolves({
          rootFolder: [
            {
              docs: [
                { _id: "d1", name: "main.tex" },
                { _id: "d2", name: "notes.md" },
              ],
              folders: [],
              fileRefs: [],
            },
          ],
        }),
      },
    };
    ctx.ProjectEntityHandler = {
      promises: {
        getDoc: sinon.stub().callsFake(async (pid, docId) => ({
          lines: docId === "d1" ? ["\\section{Hi}", "body"] : ["# Notes"],
        })),
      },
    };
    ctx.EditorController = {
      promises: { upsertDocWithPath: sinon.stub().resolves() },
    };
    ctx.AuditLogManager = {
      promises: { recordAudit: sinon.stub().resolves() },
    };
    ctx.CompileManager = {
      promises: {
        compile: sinon.stub().resolves({ status: "success", outputFiles: [] }),
      },
    };
    ctx.fetchString = sinon.stub();

    vi.doMock("../../../../../app/src/models/AiSettings.mjs", () => ({
      AiSettings: ctx.AiSettings,
    }));
    vi.doMock("../../../../../app/src/models/AiProposal.mjs", () => ({
      AiProposal: ctx.AiProposal,
    }));
    vi.doMock(
      "../../../../../app/src/Features/Project/ProjectGetter.mjs",
      () => ({ default: ctx.ProjectGetter, ProjectGetter: ctx.ProjectGetter }),
    );
    vi.doMock(
      "../../../../../app/src/Features/Project/ProjectEntityHandler.mjs",
      () => ({
        default: ctx.ProjectEntityHandler,
        ProjectEntityHandler: ctx.ProjectEntityHandler,
      }),
    );
    vi.doMock(
      "../../../../../app/src/Features/Editor/EditorController.mjs",
      () => ({
        default: ctx.EditorController,
        EditorController: ctx.EditorController,
      }),
    );
    vi.doMock("../Audit/AuditLogManager.mjs", () => ({
      default: ctx.AuditLogManager,
    }));
    vi.doMock(
      "../../../../../app/src/Features/Audit/AuditLogManager.mjs",
      () => ({
        default: ctx.AuditLogManager,
        AuditLogManager: ctx.AuditLogManager,
      }),
    );
    vi.doMock(
      "../../../../../app/src/Features/Compile/CompileManager.mjs",
      () => ({
        default: ctx.CompileManager,
        CompileManager: ctx.CompileManager,
      }),
    );
    vi.doMock("@overleaf/fetch-utils", () => ({
      fetchString: ctx.fetchString,
    }));
    ctx.CompileJobManager = {
      promises: {
        listForProject: sinon
          .stub()
          .resolves([{ jobId: "job-1", buildId: "build-1", logExcerpt: "ok" }]),
      },
    };
    vi.doMock(
      "../../../../../app/src/Features/Compile/CompileJobManager.mjs",
      () => ({ default: ctx.CompileJobManager }),
    );
    ctx.ReviewService = {
      promises: {
        getReviewStatus: sinon.stub().resolves({
          total: 2,
          unresolved: 1,
          threads: [{ resolved: false, firstMessage: "fix intro" }],
        }),
      },
    };
    vi.doMock(
      "../../../../../app/src/Features/Review/ReviewService.mjs",
      () => ({
        default: ctx.ReviewService,
      }),
    );

    ctx.service = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.resetModules();
  });

  describe("getSettings / saveSettings", function () {
    it("hides nothing until configured and reports enabled false", async function (ctx) {
      const settings = await ctx.service.promises.getSettings();
      expect(settings.enabled).to.be.false;
    });

    it("clamps maxIterations into 1..10", async function (ctx) {
      await ctx.service.promises.saveSettings({ maxIterations: 99 });
      const arg = ctx.AiSettings.updateOne.firstCall.args[1].$set;
      expect(arg.maxIterations).to.equal(10);
    });
  });

  describe("createProposal", function () {
    it("snapshots previous content for undo", async function (ctx) {
      const proposal = await ctx.service.promises.createProposal("p1", "u1", {
        path: "main.tex",
        content: "\\section{New}",
        summary: "rewrite",
      });
      expect(proposal.previousLines).to.deep.equal(["\\section{Hi}", "body"]);
      expect(proposal.newLines).to.deep.equal(["\\section{New}"]);
      expect(proposal.status).to.equal("pending");
    });

    it("normalizes bare paths with a leading slash", async function (ctx) {
      const proposal = await ctx.service.promises.createProposal("p1", "u1", {
        path: "notes.md",
        content: "x",
      });
      expect(proposal.path).to.equal("/notes.md");
    });

    it("rejects unsafe paths", async function (ctx) {
      await expect(
        ctx.service.promises.createProposal("p1", "u1", {
          path: "/../evil.tex",
          content: "x",
        }),
      ).to.be.rejectedWith(/invalid target path/);
    });
  });

  describe("applyProposal / rejectProposal", function () {
    it("applies a pending proposal through the editor and audits", async function (ctx) {
      const proposal = await ctx.service.promises.createProposal("p1", "u1", {
        path: "main.tex",
        content: "new",
      });
      const doc = {
        ...proposal,
        toObject: () => ({ ...doc }),
        save: sinon.stub().callsFake(async function () {
          doc.status = "applied";
          doc.resolvedAt = new Date();
        }),
      };
      ctx.AiProposal.findOne.returns(doc);
      const applied = await ctx.service.promises.applyProposal(
        "p1",
        "u1",
        proposal._id,
      );
      expect(applied.status).to.equal("applied");
      expect(
        ctx.EditorController.promises.upsertDocWithPath.calledWith(
          "p1",
          "/main.tex",
          ["new"],
          "ai-agent",
          "u1",
        ),
      ).to.be.true;
      const audit = ctx.AuditLogManager.promises.recordAudit.lastCall.args[0];
      expect(audit.action).to.equal("ai-edit-applied");
    });

    it("refuses to apply twice", async function (ctx) {
      ctx.AiProposal.findOne.returns(null); // not pending anymore
      await expect(
        ctx.service.promises.applyProposal("p1", "u1", "gone"),
      ).to.be.rejectedWith(/not pending/);
    });
  });

  describe("simpleDiff", function () {
    it("marks changed lines with - and +", function (ctx) {
      const diff = ctx.service.simpleDiff(["a", "b"], ["a", "c"]);
      expect(diff).to.deep.equal(["  a", "- b", "+ c"]);
    });

    it("treats a first version as all additions", function (ctx) {
      const diff = ctx.service.simpleDiff(null, ["new"]);
      expect(diff).to.deep.equal(["+ new"]);
    });
  });

  describe("generateInitDoc", function () {
    it("creates agents.md listing project files", async function (ctx) {
      const result = await ctx.service.promises.generateInitDoc("p1", "u1");
      expect(result.path).to.equal("agents.md");
      expect(result.lines.join("\n")).to.contain("main.tex");
      expect(result.lines.join("\n")).to.contain("notes.md");
    });
  });

  describe("AI permission model", function () {
    it("defaults deny dangerous capabilities", async function (ctx) {
      const settings = await ctx.service.promises.getSettings();
      expect(settings.permissions.deleteFiles).to.be.false;
      expect(settings.permissions.git).to.be.false;
      expect(settings.permissions.secrets).to.be.false;
      expect(settings.permissions.readFiles).to.be.true;
    });

    it("persists permission changes", async function (ctx) {
      await ctx.service.promises.saveSettings({
        permissions: { deleteFiles: true },
      });
      const patch = ctx.AiSettings.updateOne.firstCall.args[1].$set;
      expect(patch["permissions.deleteFiles"]).to.be.true;
      expect(patch["permissions.git"]).to.be.undefined;
    });
  });

  describe("agent tool permissions in runAgent", function () {
    it("executes permitted search_files and returns matches", async function (ctx) {
      ctx.AiSettings.findOne.returns({
        lean: () => ({
          exec: async () => ({
            enabled: true,
            baseUrl: "http://ai.test",
            apiKey: "k",
            model: "m",
            permissions: { readFiles: true },
          }),
        }),
      });
      ctx.fetchString.onFirstCall().resolves(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c1",
                    function: {
                      name: "search_files",
                      arguments: JSON.stringify({ query: "section" }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      ctx.fetchString
        .onSecondCall()
        .resolves(
          JSON.stringify({ choices: [{ message: { content: "done" } }] }),
        );
      const result = await ctx.service.promises.runAgent("p1", "u1", "find");
      const searchCall = result.transcript.find(
        (t) => t.tool === "search_files",
      );
      expect(searchCall).to.exist;
      const parsed = JSON.parse(searchCall.result);
      expect(parsed.matches.length).to.be.greaterThan(0);
    });

    it("denies tools blocked by permissions without creating proposals", async function (ctx) {
      ctx.AiSettings.findOne.returns({
        lean: () => ({
          exec: async () => ({
            enabled: true,
            baseUrl: "http://ai.test",
            apiKey: "k",
            model: "m",
            permissions: { readFiles: true, deleteFiles: false },
          }),
        }),
      });
      ctx.fetchString.onFirstCall().resolves(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c2",
                    function: {
                      name: "propose_delete_file",
                      arguments: JSON.stringify({ path: "main.tex" }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      ctx.fetchString
        .onSecondCall()
        .resolves(
          JSON.stringify({ choices: [{ message: { content: "done" } }] }),
        );
      const result = await ctx.service.promises.runAgent("p1", "u1", "clean");
      const call = result.transcript.find(
        (t) => t.tool === "propose_delete_file",
      );
      const parsed = JSON.parse(call.result);
      expect(parsed.denied).to.be.true;
    });
  });

  describe("runAgent slash commands", function () {
    it("handles /summarize-comments without calling the LLM", async function (ctx) {
      ctx.AiSettings.findOne.returns({
        lean: () => ({
          exec: async () => ({
            enabled: true,
            baseUrl: "http://ai.test",
            apiKey: "k",
            model: "m",
          }),
        }),
      });
      ctx.fetchString.resolves(
        JSON.stringify({
          choices: [{ message: { content: "1 comment concerns the intro." } }],
        }),
      );
      const result = await ctx.service.promises.runAgent(
        "p1",
        "u1",
        "/summarize-comments",
      );
      expect(result.proposals).to.deep.equal([]);
      expect(result.iterations).to.equal(0);
      expect(result.transcript[result.transcript.length - 1].content).to.equal(
        "1 comment concerns the intro.",
      );
      expect(ctx.ReviewService.promises.getReviewStatus.calledOnce).to.be.true;
    });
  });
});
