import mongoose from "../infrastructure/Mongoose.mjs";

const { Schema } = mongoose;

// One record per AI provider call (PLANS 18 "AI usage/cost"). Token counts
// come from the provider's usage block; cost is estimated at read time from
// a configurable price table so historical records never go stale.
const AiUsageSchema = new Schema(
  {
    model: { type: String, required: true },
    purpose: {
      type: String,
      enum: ["agent", "summarize", "init", "other"],
      default: "other",
    },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    projectId: { type: Schema.Types.ObjectId, ref: "Project" },
  },
  { collection: "aiUsage", timestamps: true },
);

AiUsageSchema.index({ createdAt: -1 });

export const AiUsage = mongoose.model("AiUsage", AiUsageSchema);
