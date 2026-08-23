import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Admin/AdminStorageHealthController.mjs",
);

describe("AdminStorageHealthController", function () {
  beforeEach(async function (ctx) {
    ctx.replicaSetStatus = sinon.stub();
    ctx.fetchString = sinon.stub();
    vi.doMock("../../../../../app/src/infrastructure/mongodb.mjs", () => ({
      replicaSetStatus: ctx.replicaSetStatus,
    }));
    vi.doMock("@overleaf/fetch-utils", () => ({
      fetchString: ctx.fetchString,
    }));
    vi.doMock("@overleaf/settings", () => ({
      default: {
        apis: {
          filestore: { url: "http://filestore:3009" },
          v1_history: { url: "http://history-v1:3100" },
          docstore: { url: "http://docstore:3016" },
        },
      },
    }));
    ctx.controller = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.resetModules();
  });

  async function getBody(ctx) {
    const res = { json: sinon.stub() };
    await ctx.controller.getStorageHealth({}, res);
    return res.json.firstCall.args[0];
  }

  it("reports healthy replica members and services", async function (ctx) {
    ctx.replicaSetStatus.resolves({
      set: "rs0",
      members: [
        { name: "mongo-1:27017", stateStr: "PRIMARY", health: 1 },
        { name: "mongo-2:27017", stateStr: "SECONDARY", health: 1 },
      ],
    });
    ctx.fetchString.resolves("OK");

    const body = await getBody(ctx);
    expect(body.mongo.replicaSet).to.be.true;
    expect(body.mongo.setName).to.equal("rs0");
    expect(body.mongo.healthy).to.be.true;
    expect(body.mongo.members.map(m => m.healthy)).to.deep.equal([true, true]);
    expect(body.services.every(s => s.healthy === true)).to.be.true;
  });

  it("flags an unhealthy replica member", async function (ctx) {
    ctx.replicaSetStatus.resolves({
      set: "rs0",
      members: [
        { name: "mongo-1:27017", stateStr: "PRIMARY", health: 1 },
        { name: "mongo-2:27017", stateStr: "(not reachable/healthy)", health: 0 },
      ],
    });
    ctx.fetchString.resolves("OK");

    const body = await getBody(ctx);
    // overall healthy: a PRIMARY exists
    expect(body.mongo.healthy).to.be.true;
    expect(body.mongo.members[1].healthy).to.be.false;
  });

  it("reports standalone servers as healthy without replication", async function (ctx) {
    ctx.replicaSetStatus.rejects(
      Object.assign(new Error("not running with --replSet"), { codeName: "NoReplicationEnabled" }),
    );
    ctx.fetchString.resolves("OK");

    const body = await getBody(ctx);
    expect(body.mongo.replicaSet).to.be.false;
    expect(body.mongo.standalone).to.be.true;
    expect(body.mongo.healthy).to.be.true;
  });

  it("reports unreachable mongo as unhealthy with the error", async function (ctx) {
    ctx.replicaSetStatus.rejects(new Error("connection timed out"));
    ctx.fetchString.resolves("OK");

    const body = await getBody(ctx);
    expect(body.mongo.healthy).to.be.false;
    expect(body.mongo.error).to.match(/connection timed out/);
  });

  it("flags a failing service health check", async function (ctx) {
    ctx.replicaSetStatus.resolves({
      set: "rs0",
      members: [{ name: "mongo-1:27017", stateStr: "PRIMARY", health: 1 }],
    });
    ctx.fetchString.callsFake(async url => {
      if (url.includes("history-v1")) {
        throw new Error("connect ECONNREFUSED");
      }
      return "OK";
    });

    const body = await getBody(ctx);
    const history = body.services.find(s => s.name === "history-v1");
    expect(history.healthy).to.be.false;
    expect(history.error).to.match(/ECONNREFUSED/);
    const filestore = body.services.find(s => s.name === "filestore");
    expect(filestore.healthy).to.be.true;
  });
});
