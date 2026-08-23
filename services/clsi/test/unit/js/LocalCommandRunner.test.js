import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const MODULE_PATH = path.join(
  import.meta.dirname,
  "../../../app/js/LocalCommandRunner",
);

// The runner reads live /proc data for sampling; in the test environment the
// spawned `sleep` process exists, so sampling works but numbers are not
// asserted. Timeout behavior is the contract under test.

describe("LocalCommandRunner", function () {
  let CommandRunner;

  beforeEach(async function () {
    vi.doMock("@overleaf/logger", () => ({
      default: {
        debug: sinon.stub(),
        warn: sinon.stub(),
        err: sinon.stub(),
      },
    }));
    vi.doMock("@overleaf/settings", () => ({
      default: {},
    }));
    // No redis settings -> telemetry writes are no-ops.
    vi.doMock("@overleaf/redis-wrapper", () => ({
      default: { createClient: sinon.stub().throws(new Error("not expected")) },
    }));

    CommandRunner = (await import(MODULE_PATH)).default;
  });

  afterEach(function () {
    vi.resetModules();
  });

  let pid;
  function run(command, timeoutMs) {
    return new Promise((resolve, reject) => {
      pid = CommandRunner.run(
        "project-1",
        command,
        "/tmp",
        null,
        timeoutMs,
        {},
        "standard",
        null,
        (err, output) =>
          err
            ? reject(Object.assign(err, { _output: output }))
            : resolve(output),
      );
    });
  }

  it("completes a command that finishes before the timeout", async function () {
    const output = await run(["/bin/echo", "hello"], 10000);
    expect(output.stdout).to.include("hello");
    expect(output.exitCode).to.equal(0);
  });

  it("kills the process group when the timeout elapses", async function () {
    const promise = run(["/bin/sleep", "30"], 200);
    let caught;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(Error);
    expect(caught.timedOut).to.equal(true);
    expect(caught.terminated).to.equal(true);
  });

  it("reports terminated for externally killed processes", async function () {
    const promise = run(["/bin/sleep", "30"], 60000);
    // Give the child a moment to start, then kill its process group.
    await new Promise((resolve) => setTimeout(resolve, 150));
    CommandRunner.kill(pid, () => {});
    let caught;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(Error);
    expect(caught.terminated).to.equal(true);
  });
});
