import mongoose from "../infrastructure/Mongoose.mjs";

const { Schema } = mongoose;

// Per-thread reviewer assignment (PLANS 9 "Assign comments"). One doc per
// assigned thread; deletion unassigns.
const ReviewAssignmentSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, required: true },
  threadId: { type: String, required: true },
  assigneeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  assignedBy: { type: Schema.Types.ObjectId, ref: "User" },
});

ReviewAssignmentSchema.index({ projectId: 1, threadId: 1 }, { unique: true });

export const ReviewAssignment = mongoose.model(
  "ReviewAssignment",
  ReviewAssignmentSchema,
);
