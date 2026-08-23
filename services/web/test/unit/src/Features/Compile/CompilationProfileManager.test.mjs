import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Compile/CompilationProfileManager.mjs",
);

function chainable(resolved) {
  return {
    sort: sinon.stub().returnsThis(),
    skip: sinon.stub().returnsThis(),
    limit: sinon.stub().returnsThis(),
    lean: sinon.stub().returnsThis(),
    exec: sinon.stub().resolves(resolved),
  };
}

describe("CompilationProfileManager", function () {
  beforeEach(async function (ctx) {
    ctx.CompilationProfile = {
      create: sinon.stub().callsFake(async doc => ({
        toObject: () => doc,
        ...doc,
      })),
      find: sinon.stub().returns(chainable([])),
      findOne: sinon.stub().returns(chainable(null)),
      findOneAndUpdate: sinon.stub().returns(chainable(null)),
      deleteOne: sinon.stub().returns({ exec: sinon.stub().resolves({}) }),
    };
    ctx.EditorController = {
      promises: {
        setCompiler: sinon.stub().resolves(),
        setImageName: sinon.stub().resolves(),
      },
    };
    ctx.AuditLogManager = {
      promises: { recordAudit: sinon.stub().resolves() },
    };

    vi.doMock(
      "../../../../../app/src/models/CompilationProfile.mjs",
      () => ({
        CompilationProfile: ctx.CompilationProfile,
      }),
    );
    vi.doMock(
      "../../../../../app/src/Features/Editor/EditorController.mjs",
      () => ({ default: ctx.EditorController }),
    );
    vi.doMock(
      "../../../../../app/src/Features/Audit/AuditLogManager.mjs",
      () => ({ default: ctx.AuditLogManager }),
    );

    ctx.manager = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.resetModules();
  });

  describe("createProfile", function () {
    it("creates a profile and audits it", async function (ctx) {
      const profile = await ctx.manager.promises.createProfile(
        { slug: "texlive-2026", label: "TeX Live 2026", compiler: "xelatex" },
        "u1",
      );
      expect(profile.slug).to.equal("texlive-2026");
      expect(profile.compiler).to.equal("xelatex");
      const audit = ctx.AuditLogManager.promises.recordAudit.firstCall.args[0];
      expect(audit.action).to.equal("profile-created");
      expect(audit.info.after.compiler).to.equal("xelatex");
    });

    it("rejects invalid slugs", async function (ctx) {
      await expect(
        ctx.manager.promises.createProfile({ slug: "Bad Slug!", label: "x" }),
      ).to.be.rejectedWith(/invalid profile slug/);
    });

    it("clamps timeout into the 1-30 minute range", async function (ctx) {
      await ctx.manager.promises.createProfile({
        slug: "t",
        label: "t",
        timeoutMinutes: 999,
      });
      const doc = ctx.CompilationProfile.create.firstCall.args[0];
      expect(doc.timeoutMinutes).to.equal(30);
    });
  });

  describe("updateProfile", function () {
    it("audits before and after values", async function (ctx) {
      ctx.CompilationProfile.findOne.returns(
        chainable({ slug: "p1", label: "Old" }),
      );
      ctx.CompilationProfile.findOneAndUpdate.returns(
        chainable({ slug: "p1", label: "New" }),
      );
      const after = await ctx.manager.promises.updateProfile(
        "p1",
        { label: "New" },
        "u1",
      );
      expect(after.label).to.equal("New");
      const audit = ctx.AuditLogManager.promises.recordAudit.firstCall.args[0];
      expect(audit.action).to.equal("profile-updated");
      expect(audit.info.before.label).to.equal("Old");
      expect(audit.info.after.label).to.equal("New");
    });

    it("rejects updates for unknown profiles", async function (ctx) {
      ctx.CompilationProfile.findOne.returns(chainable(null));
      await expect(
        ctx.manager.promises.updateProfile("nope", { label: "x" }),
      ).to.be.rejectedWith(/profile not found/);
    });
  });

  describe("applyToProject", function () {
    it("sets compiler and image via the editor controller and audits", async function (ctx) {
      ctx.CompilationProfile.findOne.returns(
        chainable({
          slug: "p1",
          compiler: "xelatex",
          imageName: "texlive-full:2026.08",
          texLiveVersion: "2026",
        }),
      );
      const profile = await ctx.manager.promises.applyToProject(
        "p1",
        "a1b2c3d4e5f6a1b2c3d4e5f6",
        "u1",
      );
      expect(
        ctx.EditorController.promises.setCompiler.calledWith(
          "a1b2c3d4e5f6a1b2c3d4e5f6",
          "xelatex",
        ),
      ).to.be.true;
      expect(
        ctx.EditorController.promises.setImageName.calledWith(
          "a1b2c3d4e5f6a1b2c3d4e5f6",
          "texlive-full:2026.08",
        ),
      ).to.be.true;
      const audit = ctx.AuditLogManager.promises.recordAudit.firstCall.args[0];
      expect(audit.action).to.equal("profile-applied");
      expect(audit.info.profile).to.equal("p1");
      expect(profile.compiler).to.equal("xelatex");
    });

    it("skips unset fields", async function (ctx) {
      ctx.CompilationProfile.findOne.returns(
        chainable({ slug: "p2", compiler: null, imageName: null }),
      );
      await ctx.manager.promises.applyToProject(
        "p2",
        "a1b2c3d4e5f6a1b2c3d4e5f6",
      );
      expect(ctx.EditorController.promises.setCompiler.called).to.be.false;
      expect(ctx.EditorController.promises.setImageName.called).to.be.false;
    });
  });
});
