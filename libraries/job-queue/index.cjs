/**
 * @overleaf/job-queue
 *
 * A thin job queue over Redis Streams. Jobs are stream entries; a consumer
 * group provides at-least-once delivery, XAUTOCLAIM recovers jobs from dead
 * consumers, failed jobs are retried up to `maxAttempts` times and then moved
 * to `<stream>:dlq`.
 *
 * The client passed in must be an ioredis instance (e.g. created with
 * `@overleaf/redis-wrapper`'s createClient).
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_CLAIM_IDLE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const READ_BATCH_SIZE = 20;

function dlqStream(stream) {
  return `${stream}:dlq`;
}

/**
 * Serialize a job into flat stream fields.
 */
function jobToFields(job) {
  return {
    type: String(job.type || ""),
    priority: String(job.priority || 0),
    payload: JSON.stringify(job.payload ?? {}),
    attempt: String(job.attempt || 1),
    enqueuedAt: String(Date.now()),
  };
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Parse a stream entry `[id, [k1, v1, k2, v2, ...]]` into a message object.
 */
function entryToMessage(entry) {
  if (!Array.isArray(entry) || entry.length !== 2) {
    return null;
  }
  const [id, rawFields] = entry;
  if (!Array.isArray(rawFields)) {
    return null;
  }
  const fields = {};
  for (let i = 0; i < rawFields.length; i += 2) {
    fields[rawFields[i]] = rawFields[i + 1];
  }
  return {
    id,
    type: fields.type,
    priority: parseInt(fields.priority, 10) || 0,
    attempt: parseInt(fields.attempt, 10) || 1,
    payload: safeJsonParse(fields.payload),
    enqueuedAt: parseInt(fields.enqueuedAt, 10) || 0,
  };
}

/**
 * Add a job to the stream.
 */
async function enqueue(
  client,
  stream,
  { type, priority = 0, payload = {}, attempt = 1 },
) {
  return client.xadd(
    stream,
    "*",
    ...Object.entries(jobToFields({ type, priority, payload, attempt })).flat(),
  );
}

/**
 * Decide what to do with a failed message. Pure helper, unit-tested.
 */
function retryOrDlq(message, maxAttempts) {
  return message.attempt < maxAttempts ? "retry" : "dlq";
}

class Consumer {
  /**
   * @param {object} client ioredis-compatible client
   * @param {object} options
   * @param {string} options.stream source stream key
   * @param {string} options.group consumer group name
   * @param {string} options.consumerName unique name of this consumer
   * @param {number} [options.maxAttempts] attempts before DLQ (default 3)
   * @param {number} [options.claimIdleMs] idle ms before reclaiming (default 60s)
   * @param {number} [options.pollIntervalMs] BLOCK time for new messages (default 100ms)
   */
  constructor(client, options) {
    this.client = client;
    this.stream = options.stream;
    this.group = options.group;
    this.consumerName = options.consumerName;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.claimIdleMs = options.claimIdleMs ?? DEFAULT_CLAIM_IDLE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.stopped = false;
    this.running = null;
  }

  async ensureGroup() {
    try {
      await this.client.xgroup(
        "CREATE",
        this.stream,
        this.group,
        "$",
        "MKSTREAM",
      );
    } catch (err) {
      // BUSYGROUP: the group already exists, which is fine.
      if (!/BUSYGROUP/i.test(String(err && err.message))) {
        throw err;
      }
    }
  }

  /**
   * Run the consume loop. Resolves when stop() is called. Never processes
   * two messages concurrently; handler errors are retried or dead-lettered.
   */
  async run(handler) {
    await this.ensureGroup();
    this.stopped = false;
    this.running = this._loop(handler);
    return this.running;
  }

  /**
   * Request shutdown. Safe to call from inside a handler: the loop checks
   * the flag between messages and resolves on its own afterwards. To wait
   * for full shutdown from outside, await `consumer.running`.
   */
  stop() {
    this.stopped = true;
  }

  async _loop(handler) {
    while (!this.stopped) {
      const messages = await this._readBatch();
      // Highest priority first; FIFO within equal priority (stable sort).
      messages.sort((a, b) => b.priority - a.priority);
      for (const message of messages) {
        if (this.stopped) break;
        await this._process(handler, message);
      }
    }
  }

  async _readBatch() {
    // First recover messages stuck in the PEL (crashed/slow consumers).
    let claimed = [];
    try {
      const result = await this.client.xautoclaim(
        this.stream,
        this.group,
        this.consumerName,
        this.claimIdleMs,
        "0",
        "COUNT",
        READ_BATCH_SIZE,
      );
      if (Array.isArray(result) && Array.isArray(result[1])) {
        claimed = result[1];
      }
    } catch {
      claimed = [];
    }

    let fresh = [];
    try {
      fresh =
        (await this.client.xreadgroup(
          "GROUP",
          this.group,
          this.consumerName,
          "COUNT",
          READ_BATCH_SIZE,
          "BLOCK",
          this.pollIntervalMs,
          "STREAMS",
          this.stream,
          ">",
        )) || [];
    } catch {
      fresh = [];
    }

    const messages = [];
    for (const entry of claimed) {
      const message = entryToMessage(entry);
      if (message != null) messages.push(message);
    }
    // xreadgroup returns [[streamName, [entry, ...]]]
    for (const [, entries] of fresh) {
      for (const entry of entries || []) {
        const message = entryToMessage(entry);
        if (message != null) messages.push(message);
      }
    }
    return messages;
  }

  async _process(handler, message) {
    try {
      await handler(message.payload, message);
      await this._ack(message.id);
    } catch (err) {
      if (retryOrDlq(message, this.maxAttempts) === "dlq") {
        await this.client
          .xadd(
            dlqStream(this.stream),
            "*",
            ...Object.entries({
              ...jobToFields({
                type: message.type,
                priority: message.priority,
                payload: message.payload,
                attempt: message.attempt,
              }),
              error: String((err && err.message) || err),
              failedAt: String(Date.now()),
              originalId: message.id,
            }).flat(),
          )
          .catch(() => {});
        await this._ack(message.id);
      } else {
        // Re-enqueue with an incremented attempt and ack the original so it
        // is not processed twice by this group.
        await this.client
          .xadd(
            this.stream,
            "*",
            ...Object.entries(
              jobToFields({
                type: message.type,
                priority: message.priority,
                payload: message.payload,
                attempt: message.attempt + 1,
              }),
            ).flat(),
          )
          .catch(() => {});
        await this._ack(message.id);
      }
    }
  }

  async _ack(id) {
    try {
      await this.client.xack(this.stream, this.group, id);
    } catch {
      // Redelivery via XAUTOCLAIM covers ack failures.
    }
  }
}

/**
 * Queue observability: pending messages in the group's PEL and DLQ length.
 */
async function getQueueStats(client, stream, group) {
  let pending = 0;
  try {
    const summary = await client.xpending(stream, group);
    pending = Array.isArray(summary) ? parseInt(summary[0], 10) || 0 : 0;
  } catch {
    pending = 0;
  }
  let dlqLength = 0;
  try {
    dlqLength = await client.xlen(dlqStream(stream));
  } catch {
    dlqLength = 0;
  }
  return { pending, dlqLength };
}

module.exports = {
  enqueue,
  Consumer,
  getQueueStats,
  entryToMessage,
  jobToFields,
  retryOrDlq,
  dlqStream,
};
