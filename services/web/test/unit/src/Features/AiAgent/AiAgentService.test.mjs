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
          toObject: () => ({ ...doc2 }),
          save: sinon.stub().resolves(),
        };
        ctx.AiProposalDocs.push(doc2);
        return doc2;
      }),
      findOne: sinon.stub().callsFake(async (query) => {
        const doc = ctx.AiProposalDocs.find(
          (d) =>
            String(d._id) === String(query._id) &&
            String(d.projectId) === String(query.projectId) &&
            (query.status == null || d.status === query.status),
        );
        return doc || null;
      }),
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
    ctx.AiUsageDocs = [];
    ctx.AiUsage = {
      create: sinon.stub().callsFake(async (doc) => {
        ctx.AiUsageDocs.push(doc);
        return doc;
      }),
    };
    vi.doMock("../../../../../app/src/models/AiUsage.mjs", () => ({
      AiUsage: ctx.AiUsage,
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

  describe("hunk diff and partial accept (PLANS 11)", function () {
    it("computes replacement hunks with an LCS diff", async function (ctx) {
      const hunks = ctx.service.computeHunks ? ctx.service.computeHunks : null;
      // computeHunks is internal; exercise via createProposal + listProposals
      ctx.ProjectEntityHandler.promises.getDoc.resolves({
        lines: ["line1", "line2", "line3"],
      });
      const proposal = await ctx.service.promises.createProposal("p1", "u1", {
        path: "main.tex",
        content: "line1\nCHANGED\nline3\nline4",
        summary: "test",
      });
      expect(proposal.hunks).to.have.length(2);
      expect(proposal.hunks[0].beforeLines).to.deep.equal(["line2"]);
      expect(proposal.hunks[0].afterLines).to.deep.equal(["CHANGED"]);
      expect(proposal.hunks[1].afterLines).to.deep.equal(["line4"]);
    });

    it("partial accept merges only selected hunks", async function (ctx) {
      ctx.ProjectEntityHandler.promises.getDoc.resolves({
        lines: ["a", "b", "c"],
      });
      const proposal = await ctx.service.promises.createProposal("p1", "u1", {
        path: "main.tex",
        content: "a\nB1\nc\nD2",
        summary: "two hunks",
      });
      expect(proposal.hunks.length).to.equal(2);
      // accept only the first hunk (B1), reject the second (D2)
      const applied = await ctx.service.promises.applyProposal(
        "p1",
        "u1",
        proposal._id,
        { hunks: [0] },
      );
      expect(applied.appliedHunks).to.deep.equal([0]);
      const upsert =
        ctx.EditorController.promises.upsertDocWithPath.lastCall.args;
      expect(upsert[1]).to.equal("/main.tex");
      expect(upsert[2]).to.deep.equal(["a", "B1", "c"]);
    });

    it("undo restores previous lines and audits", async function (ctx) {
      ctx.ProjectEntityHandler.promises.getDoc.resolves({
        lines: ["x1"],
      });
      const proposal = await ctx.service.promises.createProposal("p1", "u1", {
        path: "main.tex",
        content: "x2",
        summary: "undo me",
      });
      await ctx.service.promises.applyProposal("p1", "u1", proposal._id);
      // doc currently equals newLines
      ctx.ProjectEntityHandler.promises.getDoc.resolves({
        lines: ["x2"],
      });
      const undone = await ctx.service.promises.undoProposal(
        "p1",
        "u1",
        proposal._id,
      );
      expect(undone.status).to.equal("undone");
      const upsert =
        ctx.EditorController.promises.upsertDocWithPath.lastCall.args;
      expect(upsert[2]).to.deep.equal(["x1"]);
    });

    it("undo refuses when the document changed after apply", async function (ctx) {
      ctx.ProjectEntityHandler.promises.getDoc.resolves({
        lines: ["x1"],
      });
      const proposal = await ctx.service.promises.createProposal("p1", "u1", {
        path: "main.tex",
        content: "x2",
        summary: "undo refused",
      });
      await ctx.service.promises.applyProposal("p1", "u1", proposal._id);
      // human edited afterwards
      ctx.ProjectEntityHandler.promises.getDoc.resolves({
        lines: ["human edit"],
      });
      let err = null;
      try {
        await ctx.service.promises.undoProposal("p1", "u1", proposal._id);
      } catch (e) {
        err = e;
      }
      expect(err).to.exist;
      expect(err.message).to.include("undo refused");
    });
  });

  describe("AI usage tracking (PLANS 18)", function () {
    it("records token usage from provider responses", async function (ctx) {
      ctx.AiSettings.findOne.returns({
        lean: () => ({
          exec: async () => ({
            enabled: true,
            baseUrl: "http://ai.test",
            apiKey: "k",
            model: "gpt-test",
            permissions: { readFiles: true },
          }),
        }),
      });
      ctx.fetchString.onFirstCall().resolves(
        JSON.stringify({
          choices: [{ message: { content: "done" } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      );
      await ctx.service.promises.runAgent("p1", "u1", "hello");
      expect(ctx.AiUsageDocs).to.have.length(1);
      const rec = ctx.AiUsageDocs[0];
      expect(rec.model).to.equal("gpt-test");
      expect(rec.purpose).to.equal("agent");
      expect(rec.promptTokens).to.equal(100);
      expect(rec.completionTokens).to.equal(20);
    });

    it("never breaks the agent run when usage recording fails", async function (ctx) {
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
      ctx.AiUsage.create.rejects(new Error("db down"));
      ctx.fetchString.resolves(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
      const result = await ctx.service.promises.runAgent("p1", "u1", "hi");
      expect(
        result.transcript[result.transcript.length - 1].assistant,
      ).to.equal("ok");
    });
  });

  describe("/init companion docs (PLANS 12)", function () {
    it("generates bibliography.md when .bib files exist", async function (ctx) {
      ctx.ProjectGetter.promises.getProject.callsFake(async (pid, proj) => {
        if (proj && proj.owner_ref != null) return { owner_ref: "u1" };
        return {
          rootFolder: [
            {
              docs: [
                { _id: "d1", name: "main.tex" },
                { _id: "d2", name: "refs.bib" },
              ],
              folders: [],
              fileRefs: [],
            },
          ],
        };
      });
      ctx.ProjectEntityHandler.promises.getDoc.resolves({
        lines: [
          "\\documentclass{article}",
          "\\bibliographystyle{ieee}",
          "\\begin{document}text\\end{document}",
        ],
      });
      const result = await ctx.service.promises.generateInitDoc("p1", "u1");
      expect(result.files).to.include("bibliography.md");
      expect(result.lines.join("\n")).to.contain("Citation style: ieee");
      const upserts =
        ctx.EditorController.promises.upsertDocWithPath.getCalls();
      const paths = upserts.map((c) => c.args[1]);
      expect(paths).to.include("/bibliography.md");
      const bibCall = upserts.find((c) => c.args[1] === "/bibliography.md");
      expect(bibCall.args[2].join("\n")).to.contain("Do not invent citations");
    });

    it("skips bibliography.md without .bib files", async function (ctx) {
      const result = await ctx.service.promises.generateInitDoc("p1", "u1");
      expect(result.files).to.deep.equal(["agents.md"]);
    });

    it("extracts relevant files from the compile log", async function (ctx) {
      ctx.AiSettings.findOne.returns({
        lean: () => ({
          exec: async () => ({
            enabled: true,
            baseUrl: "http://ai.test",
            apiKey: "k",
            model: "m",
            permissions: { readFiles: true, compile: true },
          }),
        }),
      });
      ctx.CompileManager.promises.compile.resolves({
        status: "failed",
        outputFiles: [],
      });
      ctx.CompileJobManager.promises.listForProject.resolves([
        {
          logExcerpt:
            "./main.tex:12: Undefined control sequence. Also errors.tex:3",
        },
      ]);
      ctx.fetchString.onFirstCall().resolves(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c5",
                    function: { name: "compile_project", arguments: "{}" },
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
      const result = await ctx.service.promises.runAgent("p1", "u1", "fix");
      expect(result.compile.relevantFiles).to.include("main.tex");
      expect(result.compile.relevantFiles).to.include("errors.tex");
    });
  });

  describe("agent failure presentation (PLANS 13)", function () {
    it("returns final compile status and log excerpt", async function (ctx) {
      ctx.AiSettings.findOne.returns({
        lean: () => ({
          exec: async () => ({
            enabled: true,
            baseUrl: "http://ai.test",
            apiKey: "k",
            model: "m",
            permissions: { readFiles: true, compile: true },
          }),
        }),
      });
      ctx.CompileManager.promises.compile.resolves({
        status: "failed",
        outputFiles: [],
      });
      ctx.fetchString.onFirstCall().resolves(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c1",
                    function: { name: "compile_project", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      );
      ctx.fetchString.onSecondCall().resolves(
        JSON.stringify({
          choices: [{ message: { content: "still failing" } }],
        }),
      );
      const result = await ctx.service.promises.runAgent("p1", "u1", "fix");
      expect(result.compile.status).to.equal("failed");
      expect(result.compile.logExcerpt).to.equal("ok");
    });

    it("omits compile info when no compile ran", async function (ctx) {
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
      ctx.fetchString.resolves(
        JSON.stringify({ choices: [{ message: { content: "hi" } }] }),
      );
      const result = await ctx.service.promises.runAgent("p1", "u1", "hello");
      expect(result.compile.status).to.be.null;
    });
  });

  describe("list_secrets tool (PLANS 10/15)", function () {
    it("is denied without the secrets permission", async function (ctx) {
      ctx.AiSettings.findOne.returns({
        lean: () => ({
          exec: async () => ({
            enabled: true,
            baseUrl: "http://ai.test",
            apiKey: "k",
            model: "m",
            permissions: { readFiles: true, secrets: false },
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
                    id: "c9",
                    function: { name: "list_secrets", arguments: "{}" },
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
      const result = await ctx.service.promises.runAgent("p1", "u1", "secrets");
      const call = result.transcript.find((t) => t.tool === "list_secrets");
      expect(JSON.parse(call.result).denied).to.be.true;
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
