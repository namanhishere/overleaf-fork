import mongoose from "../infrastructure/Mongoose.mjs";
const { Schema } = mongoose;

export const CompileJobSchema = new Schema(
  {
    jobId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, required: true, index: true },
    userId: { type: Schema.Types.ObjectId },
    status: {
      type: String,
      enum: ["queued", "running", "success", "failed", "cancelled", "timeout"],
      default: "queued",
    },
    priority: { type: Number, default: 0 },
    workerId: { type: String },
    pid: { type: Number },
    queuedAt: { type: Date, default: Date.now },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    runtimeMs: { type: Number },
    peakCpuPercent: { type: Number },
    peakRssBytes: { type: Number },
    peakDiskBytes: { type: Number },
    attempts: { type: Number, default: 1 },
    imageName: { type: String },
    compiler: { type: String },
    timeoutMs: { type: Number },
    exitCode: { type: Number },
    error: { type: String },
    logExcerpt: { type: String },
    buildId: { type: String },
  },
  {
    collection: "compileJobs",
    minimize: false,
  },
);

CompileJobSchema.index({ projectId: 1, queuedAt: -1 });
CompileJobSchema.index({ status: 1, startedAt: -1 });

// Retention note: entries older than Settings.compileJobRetentionDays
// (default 90) are purged by a periodic cleanup script (Phase 2 cron);
// no TTL index so admin dashboards keep full recent history.

export const CompileJob = mongoose.model("CompileJob", CompileJobSchema);
