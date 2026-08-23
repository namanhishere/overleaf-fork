const { expect } = require("chai");
const sinon = require("sinon");
const {
  enqueue,
  Consumer,
  entryToMessage,
  jobToFields,
  retryOrDlq,
  dlqStream,
} = require("../index.cjs");

describe("@overleaf/job-queue", function () {
  describe("entryToMessage", function () {
    it("parses flat field arrays", function () {
      const message = entryToMessage([
        "123-1",
        [
          "type",
          "compile",
          "priority",
          "5",
          "attempt",
          "2",
          "payload",
          '{"a":1}',
          "enqueuedAt",
          "123",
        ],
      ]);
      expect(message).to.deep.equal({
        id: "123-1",
        type: "compile",
        priority: 5,
        attempt: 2,
        payload: { a: 1 },
        enqueuedAt: 123,
      });
    });

    it("defaults attempt and priority", function () {
      const message = entryToMessage(["1-1", ["type", "x", "payload", "null"]]);
      expect(message.attempt).to.equal(1);
      expect(message.priority).to.equal(0);
    });

    it("returns null for malformed entries", function () {
      expect(entryToMessage(null)).to.be.null;
      expect(entryToMessage(["id"])).to.be.null;
      expect(entryToMessage(["id", "not-an-array"])).to.be.null;
    });
  });

  describe("retryOrDlq", function () {
    it("retries below maxAttempts and dead-letters at it", function () {
      expect(retryOrDlq({ attempt: 1 }, 3)).to.equal("retry");
      expect(retryOrDlq({ attempt: 2 }, 3)).to.equal("retry");
      expect(retryOrDlq({ attempt: 3 }, 3)).to.equal("dlq");
    });
  });

  describe("enqueue", function () {
    it("adds serialized job fields to the stream", async function () {
      const client = { xadd: sinon.stub().resolves("1-1") };
      await enqueue(client, "jobs:stream", {
        type: "compile",
        payload: { jobId: "j1" },
      });
      const args = client.xadd.firstCall.args;
      expect(args[0]).to.equal("jobs:stream");
      expect(args[1]).to.equal("*");
      const fields = args.slice(2);
      const obj = {};
      for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
      expect(obj.type).to.equal("compile");
      expect(obj.priority).to.equal("0");
      expect(obj.attempt).to.equal("1");
      expect(JSON.parse(obj.payload)).to.deep.equal({ jobId: "j1" });
    });
  });

  describe("Consumer", function () {
    function makeClient(entries) {
      return {
        xgroup: sinon.stub().resolves(),
        xautoclaim: sinon.stub().resolves(["0", []]),
        xreadgroup: sinon.stub().resolves([["jobs:stream", entries]]),
        xack: sinon.stub().resolves(1),
        xadd: sinon.stub().resolves("9-1"),
      };
    }

    function makeConsumer(client, options = {}) {
      return new Consumer(client, {
        stream: "jobs:stream",
        group: "compilers",
        consumerName: "test-consumer",
        pollIntervalMs: 1,
        ...options,
      });
    }

    it("processes messages in priority order and acks them", async function () {
      const handled = [];
      const entries = [
        ["1-1", ["type", "low", "priority", "0", "payload", "{}"]],
        ["1-2", ["type", "high", "priority", "10", "payload", "{}"]],
      ];
      const client = makeClient(entries);
      const consumer = makeConsumer(client);
      let processed = 0;
      const runPromise = consumer.run(async (payload, message) => {
        handled.push(message.type);
        if (++processed === 2) await consumer.stop();
      });
      await runPromise;
      expect(handled).to.deep.equal(["high", "low"]);
      expect(client.xack.calledTwice).to.be.true;
    });

    it("retries failed jobs with incremented attempt", async function () {
      const entries = [
        [
          "1-1",
          ["type", "boom", "priority", "0", "payload", "{}", "attempt", "1"],
        ],
      ];
      const client = makeClient(entries);
      // After the retry XADD, the next read sees the attempt-2 copy.
      client.xreadgroup
        .onSecondCall()
        .resolves([
          [
            "jobs:stream",
            [
              [
                "1-2",
                [
                  "type",
                  "boom",
                  "priority",
                  "0",
                  "payload",
                  "{}",
                  "attempt",
                  "2",
                ],
              ],
            ],
          ],
        ]);
      const consumer = makeConsumer(client, { maxAttempts: 2 });
      let calls = 0;
      const handler = async () => {
        calls++;
        if (calls === 1) throw new Error("first failure");
        await consumer.stop();
      };
      await consumer.run(handler);
      expect(calls).to.equal(2);
      const retriedFields = client.xadd.firstCall.args.slice(2);
      const obj = {};
      for (let i = 0; i < retriedFields.length; i += 2)
        obj[retriedFields[i]] = retriedFields[i + 1];
      expect(obj.attempt).to.equal("2");
      expect(client.xack.calledTwice).to.be.true;
      expect(client.xadd.firstCall.args[0]).to.equal("jobs:stream");
    });

    it("dead-letters after exhausting attempts", async function () {
      const client = makeClient([
        [
          "1-1",
          [
            "type",
            "poison",
            "priority",
            "0",
            "payload",
            '{"jobId":"j"}',
            "attempt",
            "3",
          ],
        ],
      ]);
      const consumer = makeConsumer(client, { maxAttempts: 3 });
      let calls = 0;
      // The stubbed stream keeps returning the same entry on every read;
      // stop the loop on the second delivery so the process can exit.
      await consumer.run(async () => {
        calls++;
        if (calls === 1) {
          throw new Error("always fails");
        }
        consumer.stop();
      });
      expect(calls).to.equal(2);
      expect(client.xadd.firstCall.args[0]).to.equal(dlqStream("jobs:stream"));
      const fields = client.xadd.firstCall.args.slice(2);
      const obj = {};
      for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
      expect(obj.error).to.equal("always fails");
      expect(JSON.parse(obj.payload)).to.deep.equal({ jobId: "j" });
      // one ack for the dead-lettered message, one for the stop-delivery
      expect(client.xack.calledTwice).to.be.true;
    });

    it("ignores BUSYGROUP on ensureGroup", async function () {
      const client = {
        xgroup: sinon
          .stub()
          .rejects(new Error("BUSYGROUP Consumer Group name already exists")),
      };
      const consumer = makeConsumer(client);
      await consumer.ensureGroup();
      expect(client.xgroup.calledOnce).to.be.true;
    });
  });
});
