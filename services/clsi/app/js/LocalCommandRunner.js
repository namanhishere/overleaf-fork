import { spawn } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import Path from "node:path";
import _ from "lodash";
import logger from "@overleaf/logger";
import Settings from "@overleaf/settings";
import RedisWrapper from "@overleaf/redis-wrapper";
let CommandRunner;

logger.debug("using standard command runner");

// Track PIDs that have been intentionally killed so that the close handler
// can detect termination even when the child exits with a numeric code instead
// of being reported as killed by a signal (e.g. exit code 4 from latexmk).
const killedPids = new Set();

// ---------------------------------------------------------------------------
// Redis job telemetry
//
// When web submits a compile with a jobId (env OVERLEAF_JOB_ID), progress and
// final stats are published to the hash `clsi:job:{jobId}` so that web can
// surface live job state without polling each worker over HTTP.
// ---------------------------------------------------------------------------

let redisClient;
function getRedisClient() {
  if (redisClient != null) {
    return redisClient;
  }
  const redisSettings = Settings.redis?.clsi || Settings.redis?.web;
  if (!redisSettings) {
    return null;
  }
  redisClient = RedisWrapper.createClient(redisSettings);
  return redisClient;
}

const JOB_HASH_TTL_SECONDS = 3600;

async function writeJobHash(jobId, fields) {
  const client = getRedisClient();
  if (!client) {
    return;
  }
  try {
    const key = `clsi:job:${jobId}`;
    await client.hset(key, fields);
    await client.expire(key, JOB_HASH_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, jobId }, "failed to write job telemetry");
  }
}

function formatRuntimeMs(startTime) {
  return String(Math.max(Date.now() - startTime, 0));
}

// ---------------------------------------------------------------------------
// Process tree sampler
//
// Samples the compile process group once per second, accumulating CPU time
// and resident memory across the whole tree, tracking peaks. Reads come from
// /proc so no external tooling is required.
// ---------------------------------------------------------------------------

const SAMPLE_INTERVAL_MS = 1000;
const CLOCK_TICKS_PER_SECOND = 100; // _SC_CLK_TCK on Linux
const PAGE_SIZE_BYTES = 4096;

function readChildrenPids(pid) {
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
  } catch {
    return [];
  }
  return raw.trim().split(/\s+/).filter(Boolean).map(Number);
}

function collectTreePids(rootPid) {
  const pids = [rootPid];
  // Guard against pathological trees; latex trees are shallow.
  for (let i = 0; i < pids.length && i < 512; i++) {
    pids.push(...readChildrenPids(pids[i]));
  }
  return pids;
}

/**
 * Returns { cpuTicks, rssBytes } summed across the process tree, or null if
 * the root process is gone.
 */
function sampleProcessTree(rootPid) {
  try {
    fs.readFileSync(`/proc/${rootPid}/stat`, "utf8");
  } catch {
    return null;
  }
  let cpuTicks = 0;
  let rssBytes = 0;
  let alive = false;
  for (const pid of collectTreePids(rootPid)) {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm may contain spaces/parens; split after the last ')'.
      const rest = raw.slice(raw.lastIndexOf(")") + 2);
      const fields = rest.split(" ");
      // fields start at "state" (index 0): utime=11, stime=12
      const utime = parseInt(fields[11], 10) || 0;
      const stime = parseInt(fields[12], 10) || 0;
      cpuTicks += utime + stime;
      const statm = fs.readFileSync(`/proc/${pid}/statm`, "utf8");
      const residentPages = parseInt(statm.split(" ")[1], 10) || 0;
      rssBytes += residentPages * PAGE_SIZE_BYTES;
      alive = true;
    } catch {
      // process already exited; ignore
    }
  }
  return alive ? { cpuTicks, rssBytes } : null;
}

class ProcessSampler {
  constructor(rootPid) {
    this.rootPid = rootPid;
    this.timer = setInterval(() => this._sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref();
    this.lastSample = null;
    this.lastSampleAt = Date.now();
    this.peakCpuPercent = 0;
    this.peakRssBytes = 0;
    this.currentCpuPercent = 0;
    /** Latest snapshot consumer, updated by _sample(). */
    this.onSample = null;
    this._sample();
  }

  _sample() {
    const sample = sampleProcessTree(this.rootPid);
    const now = Date.now();
    if (sample == null) {
      return;
    }
    if (this.lastSample != null) {
      const deltaTicks = sample.cpuTicks - this.lastSample.cpuTicks;
      const deltaMs = Math.max(now - this.lastSampleAt, 1);
      const elapsedTicks = (deltaMs / 1000) * CLOCK_TICKS_PER_SECOND;
      this.currentCpuPercent =
        elapsedTicks > 0 ? (deltaTicks / elapsedTicks) * 100 : 0;
    }
    this.lastSample = sample;
    this.lastSampleAt = now;
    if (this.currentCpuPercent > this.peakCpuPercent) {
      this.peakCpuPercent = this.currentCpuPercent;
    }
    if (sample.rssBytes > this.peakRssBytes) {
      this.peakRssBytes = sample.rssBytes;
    }
    if (this.onSample != null) {
      this.onSample({
        cpuPercent: Math.round(this.currentCpuPercent * 10) / 10,
        rssBytes: sample.rssBytes,
      });
    }
  }

  stop() {
    clearInterval(this.timer);
    return {
      peakCpuPercent: Math.round(this.peakCpuPercent * 10) / 10,
      peakRssBytes: this.peakRssBytes,
    };
  }
}

// Total size in bytes of a directory tree, capped to avoid walking
// pathological trees (PLANS 3 "Disk usage" telemetry).
function directorySize(dir, depth = 0) {
  let total = 0;
  if (depth > 6) return total;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const entry of entries) {
    const full = Path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += directorySize(full, depth + 1);
      } else {
        total += fs.statSync(full).size;
      }
    } catch {
      // files vanishing mid-walk are fine
    }
  }
  return total;
}

export default CommandRunner = {
  run(
    projectId,
    command,
    directory,
    image,
    timeout,
    environment,
    compileGroup,
    cwd,
    callback,
  ) {
    let key, value;
    callback = _.once(callback);
    const spawnCwd = cwd ? Path.join(directory, cwd) : directory;
    command = Array.from(command).map((arg) =>
      arg.toString().replace("$COMPILE_DIR", directory),
    );
    logger.debug(
      { projectId, command, directory, cwd: spawnCwd },
      "running command",
    );
    logger.warn("sandboxing is not enabled with CommandRunner");

    // merge environment settings
    const env = {};
    for (key in process.env) {
      value = process.env[key];
      env[key] = value;
    }
    for (key in environment) {
      value = environment[key];
      env[key] = value;
    }

    // Job telemetry context (set by web through LatexRunner).
    const jobId = env.OVERLEAF_JOB_ID || null;

    // run command as detached process so it has its own process group (which can be killed if needed)
    const proc = spawn(command[0], command.slice(1), {
      cwd: spawnCwd,
      env,
      // stdin must not be an open pipe: with a detached process group,
      // children can block waiting on it (observed with latexmk).
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });

    let stdout = "";
    proc.stdout.setEncoding("utf8").on("data", (data) => (stdout += data));

    // Enforce the compile timeout: kill the whole process group when it
    // fires. Previously this runner ignored the timeout entirely.
    let timedOut = false;
    const timeoutTimer = setTimeout(function () {
      timedOut = true;
      logger.warn(
        { projectId, jobId, timeoutMs: timeout },
        "compile exceeded timeout, killing process group",
      );
      try {
        killedPids.add(proc.pid);
        process.kill(-proc.pid);
      } catch (err) {
        logger.warn(
          { err, projectId, pid: proc.pid },
          "failed to kill timed-out process group",
        );
      }
    }, timeout || 60000);

    let sampler = null;
    const jobStartedAt = Date.now();
    if (jobId != null && proc.pid != null) {
      sampler = new ProcessSampler(proc.pid);
      void writeJobHash(jobId, {
        status: "running",
        projectId: String(projectId),
        pid: String(proc.pid),
        workerId: Settings.clsi?.CLSI_SERVER_ID || "",
        startedAt: String(jobStartedAt),
      });
      sampler.onSample = ({ cpuPercent, rssBytes }) => {
        void writeJobHash(jobId, {
          status: "running",
          pid: String(proc.pid),
          cpuPercent: String(cpuPercent),
          rssBytes: String(rssBytes),
          updatedAt: String(Date.now()),
        });
      };
    }

    proc.on("error", function (err) {
      killedPids.delete(proc.pid);
      clearTimeout(timeoutTimer);
      if (sampler != null) sampler.stop();
      logger.err(
        { err, projectId, command, directory },
        "error running command",
      );
      return callback(err);
    });

    proc.on("close", function (code, signal) {
      let err;
      logger.debug({ code, signal, projectId }, "command exited");
      clearTimeout(timeoutTimer);
      const stats = sampler != null ? sampler.stop() : {};
      if (jobId != null) {
        const stillKilled = killedPids.has(proc.pid);
        const status = timedOut
          ? "timeout"
          : stillKilled || signal === "SIGTERM"
            ? "terminated"
            : "finished";
        void writeJobHash(jobId, {
          status,
          exitCode: String(code ?? ""),
          runtimeMs: formatRuntimeMs(jobStartedAt),
          peakCpuPercent: String(stats.peakCpuPercent ?? ""),
          peakRssBytes: String(stats.peakRssBytes ?? ""),
          logExcerpt: stdout.slice(-8192),
          updatedAt: String(Date.now()),
        });
        // Disk usage (PLANS 3): measured after the compile so outputs are
        // included; written separately since the walk is asynchronous work.
        fs.stat(directory, () => {
          const diskBytes = directorySize(directory);
          void writeJobHash(jobId, {
            peakDiskBytes: String(diskBytes),
            updatedAt: String(Date.now()),
          });
        });
      }
      const wasKilled = killedPids.delete(proc.pid);
      if (timedOut) {
        err = new Error("compile timed out");
        err.terminated = true;
        err.timedOut = true;
        return callback(err);
      } else if (signal === "SIGTERM" || wasKilled) {
        err = new Error("terminated");
        err.terminated = true;
        return callback(err);
      } else if (code === 1) {
        // exit status from chktex
        err = new Error("exited");
        err.code = code;
        return callback(err);
      } else {
        return callback(null, { stdout, exitCode: code, stats });
      }
    });

    return proc.pid;
  }, // return process id to allow job to be killed if necessary

  kill(pid, callback) {
    if (callback == null) {
      callback = function () {};
    }
    try {
      killedPids.add(pid);
      process.kill(-pid); // kill all processes in group
    } catch (err) {
      killedPids.delete(pid);
      return callback(err);
    }
    return callback();
  },

  canRunSyncTeXInOutputDir() {
    return true;
  },
};

CommandRunner.promises = {
  run: promisify(CommandRunner.run),
  kill: promisify(CommandRunner.kill),
};
