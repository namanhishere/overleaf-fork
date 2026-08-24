import { expect } from "vitest";
import { vi, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Secrets/SecretsService.mjs",
);

describe("SecretsService", function () {
  beforeEach(async function (ctx) {
    process.env.OVERLEAF_SECRETS_KEY = "test-master-key";
    ctx.stored = {};
    const findByProject = ({ projectId }) => {
      const rows = Object.entries(ctx.stored)
        .filter(([, s]) => s.projectId === projectId)
        .map(([, s]) => ({ ...s }));
      const chain = {
        sort: () => chain,
        lean: () => chain,
        exec: async () => rows,
      };
      return chain;
    };
    ctx.ProjectSecret = {
      find: sinon.stub().callsFake(findByProject),
      findOne: sinon.stub().callsFake(({ projectId, key }) => ({
        lean: async () => ctx.stored[projectId + ':' + key] || null,
      })),
      updateOne: sinon.stub().callsFake(async ({ projectId, key }, update) => {
        ctx.stored[`${projectId}:${key}`] ??= {
          projectId,
          key,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: null,
        };
        Object.assign(ctx.stored[`${projectId}:${key}`], update.$set);
      }),
      deleteOne: sinon.stub().callsFake(({ projectId, key }) => {
        const k = `${projectId}:${key}`;
        const existed = ctx.stored[k] != null;
        delete ctx.stored[k];
        return { exec: async () => ({ deletedCount: existed ? 1 : 0 }) };
      }),
    };
    ctx.AuditLogManager = {
      promises: { recordAudit: sinon.stub().resolves() },
    };
    vi.doMock("../../../../../app/src/models/ProjectSecret.mjs", () => ({
      ProjectSecret: ctx.ProjectSecret,
    }));
    vi.doMock(
      "../../../../../app/src/Features/Audit/AuditLogManager.mjs",
      () => ({ default: ctx.AuditLogManager }),
    );
    ctx.service = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.resetModules();
    delete process.env.OVERLEAF_SECRETS_KEY;
  });

  it("encrypts values at rest and round-trips via resolveSecrets", async function (ctx) {
    await ctx.service.promises.setSecret(
      "p1",
      "ZENODO_TOKEN",
      "super-secret-value",
      "u1",
    );
    const stored = Object.values(ctx.stored)[0];
    expect(stored.valueEncrypted).to.not.contain("super-secret-value");
    expect(stored.valueEncrypted).to.match(/^v1:/);
    const resolved = await ctx.service.promises.resolveSecrets("p1");
    expect(resolved.ZENODO_TOKEN).to.equal("super-secret-value");
  });

  it("lists only names and metadata, never values", async function (ctx) {
    await ctx.service.promises.setSecret("p1", "AWS_KEY", "waffles", "u1");
    const listed = await ctx.service.promises.listSecrets("p1");
    expect(listed).to.have.lengthOf(1);
    expect(listed[0].key).to.equal("AWS_KEY");
    expect(JSON.stringify(listed)).to.not.contain("waffles");
  });

  it("rejects invalid keys", async function (ctx) {
    await expect(
      ctx.service.promises.setSecret("p1", "bad-key", "v", "u1"),
    ).to.be.rejectedWith(/invalid secret key/);
    await expect(
      ctx.service.promises.setSecret("p1", "1BAD", "v", "u1"),
    ).to.be.rejectedWith(/invalid secret key/);
  });

  it("audits create/update/delete without values", async function (ctx) {
    await ctx.service.promises.setSecret("p1", "TOKEN_A", "v1", "u1");
    await ctx.service.promises.setSecret("p1", "TOKEN_A", "v2", "u1");
    await ctx.service.promises.deleteSecret("p1", "TOKEN_A", "u1");
    const actions = ctx.AuditLogManager.promises.recordAudit.getCalls().map(
      c => c.args[0].action,
    );
    expect(actions).to.deep.equal([
      "secret-created",
      "secret-updated",
      "secret-deleted",
    ]);
    for (const call of ctx.AuditLogManager.promises.recordAudit.getCalls()) {
      expect(JSON.stringify(call.args[0].info)).to.not.contain("v1");
      expect(JSON.stringify(call.args[0].info)).to.not.contain("v2");
    }
  });

  it("throws on deleting an unknown secret", async function (ctx) {
    await expect(
      ctx.service.promises.deleteSecret("p1", "NOPE", "u1"),
    ).to.be.rejectedWith(/secret not found/);
  });
});
