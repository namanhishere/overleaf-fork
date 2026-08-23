import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Releases/ProjectReleasesManager.mjs",
);

describe("ProjectReleasesManager", function () {
  beforeEach(async function (ctx) {
    ctx.ProjectRelease = {
      create: sinon.stub().callsFake(async doc => ({
        toObject: () => doc,
        ...doc,
      })),
      find: sinon.stub(),
      countDocuments: sinon.stub().resolves(0),
      findOne: sinon.stub(),
    };
    ctx.CompileJob = {
      // Chainable findOne: .sort(...).lean(...).exec() resolves per-test.
      findOne: sinon.stub().returns({
        sort: sinon.stub().returnsThis(),
        lean: sinon.stub().returnsThis(),
        exec: sinon.stub().resolves(null),
      }),
    };
    ctx.AuditLogManager = {
      promises: { recordAudit: sinon.stub().resolves() },
    };

    vi.doMock("../../../../../app/src/models/ProjectRelease.mjs", () => ({
      ProjectRelease: ctx.ProjectRelease,
    }));
    vi.doMock("../../../../../app/src/models/CompileJob.mjs", () => ({
      CompileJob: ctx.CompileJob,
    }));
    vi.doMock("../../../../../app/src/Features/Audit/AuditLogManager.mjs", () => ({
      default: ctx.AuditLogManager,
    }));

    ctx.manager = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.resetModules();
  });

  describe("createRelease", function () {
    it("pins the latest successful compile when no buildId is given", async function (ctx) {
      const exec = sinon
        .stub()
        .onFirstCall()
        .resolves({
          jobId: "job-1",
          buildId: "build-1",
          imageName: null,
          compiler: "pdflatex",
        })
        .onSecondCall()
        .resolves({
          jobId: "job-1",
          buildId: "build-1",
          compiler: "pdflatex",
        });
      ctx.CompileJob.findOne.returns({
        sort: sinon.stub().returnsThis(),
        lean: sinon.stub().returnsThis(),
        exec,
      });

      const release = await ctx.manager.promises.createRelease(
        "p1",
        { tag: "v1.0", userId: "u1" },
      );
      expect(release.buildId).to.equal("build-1");
      expect(release.jobId).to.equal("job-1");
      expect(ctx.AuditLogManager.promises.recordAudit.calledOnce).to.be.true;
      const auditArgs = ctx.AuditLogManager.promises.recordAudit.firstCall.args[0];
      expect(auditArgs.action).to.equal("release-created");
      expect(auditArgs.info.tag).to.equal("v1.0");
    });

    it("rejects invalid tags", async function (ctx) {
      await expect(
        ctx.manager.promises.createRelease("p1", { tag: "not a tag!" }),
      ).to.be.rejectedWith(/invalid release tag/);
      expect(ctx.ProjectRelease.create.called).to.be.false;
    });

    it("rejects creation when there is nothing to release", async function (ctx) {
      ctx.CompileJob.findOne.returns({
        sort: sinon.stub().returnsThis(),
        lean: sinon.stub().returnsThis(),
        exec: sinon.stub().resolves(null),
      });
      await expect(
        ctx.manager.promises.createRelease("p1", { tag: "v1.0" }),
      ).to.be.rejectedWith(/no successful compile/);
    });

    it("surfaces duplicate tags as errors", async function (ctx) {
      ctx.CompileJob.findOne.returns({
        sort: sinon.stub().returnsThis(),
        lean: sinon.stub().returnsThis(),
        exec: sinon.stub().resolves({ jobId: "job-1", buildId: "build-1" }),
      });
      ctx.ProjectRelease.create.rejects(Object.assign(new Error("dup"), { code: 11000 }));
      await expect(
        ctx.manager.promises.createRelease("p1", { tag: "v1.0" }),
      ).to.be.rejectedWith(/duplicate release tag/);
    });
  });

  describe("listReleases", function () {
    it("returns releases and total", async function (ctx) {
      const limitStub = sinon.stub().returnsThis();
      ctx.ProjectRelease.find.returns({
        sort: sinon.stub().returnsThis(),
        skip: sinon.stub().returnsThis(),
        limit: sinon.stub().returnsThis(),
        lean: sinon.stub().returnsThis(),
        exec: sinon.stub().resolves([{ tag: "v1.0" }]),
      });
      ctx.ProjectRelease.countDocuments.resolves(1);
      const result = await ctx.manager.promises.listReleases("p1");
      expect(result.releases).to.deep.equal([{ tag: "v1.0" }]);
      expect(result.total).to.equal(1);
    });
  });
});
