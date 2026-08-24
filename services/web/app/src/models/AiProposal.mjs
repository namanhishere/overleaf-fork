import mongoose from "../infrastructure/Mongoose.mjs";

const { Schema } = mongoose;

// A file modification proposed by the AI agent. The agent NEVER writes
// directly: proposals carry the previous content (snapshot/undo) and are
// only applied after explicit human approval.
const AiProposalSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, default: null },
    path: { type: String, required: true },
    // Snapshot of the previous content (null = file is new) for undo.
    previousLines: { type: [String], default: null },
    newLines: { type: [String], default: null },
    action: { type: String, default: "write", enum: ["write", "delete"] },
    // Hunk-level diff (PLANS 11 partial accept). Each hunk replaces
    // previousLines[beforeStart..beforeStart+beforeLines.length] with
    // afterLines.
    hunks: {
      type: [
        {
          beforeStart: { type: Number, required: true },
          beforeLines: { type: [String], default: [] },
          afterStart: { type: Number, required: true },
          afterLines: { type: [String], default: [] },
        },
      ],
      default: undefined,
    },
    appliedHunks: { type: [Number], default: null },
    // pending | applied | rejected
    status: {
      type: String,
      enum: ["pending", "applied", "rejected", "undone"],
      default: "pending",
    },
    summary: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date, default: null },
  },
  { collection: "aiProposals", timestamps: true },
);

AiProposalSchema.index({ projectId: 1, status: 1, createdAt: -1 });

export const AiProposal = mongoose.model("AiProposal", AiProposalSchema);
