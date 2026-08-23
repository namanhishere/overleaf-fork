import mongoose from "../infrastructure/Mongoose.mjs";

const { Schema } = mongoose

// Immutable, traceable release of a project: pins a source snapshot
// (history version), a compiled PDF (CLSI buildId) and the compiler
// environment used, so a submission can be reproduced later.
const ProjectReleaseSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    // Human-facing version tag, unique per project, e.g. "v1.0".
    tag: { type: String, required: true },
    // Project history version of the source snapshot, when known.
    version: { type: Number, default: null },
    // CLSI build id of the compiled PDF this release pins.
    buildId: { type: String, required: true },
    // Compiler environment traceability.
    imageName: { type: String, default: null },
    compiler: { type: String, default: null },
    // The compile job that produced the build, for full telemetry lookup.
    jobId: { type: String, default: null },
    notes: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, default: null },
  },
  { collection: "projectReleases", timestamps: true },
)
ProjectReleaseSchema.index({ projectId: 1, createdAt: -1 })

export const ProjectRelease = mongoose.model(
  'ProjectRelease',
  ProjectReleaseSchema
)
