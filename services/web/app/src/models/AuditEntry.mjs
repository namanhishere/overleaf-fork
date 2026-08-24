import mongoose from "../infrastructure/Mongoose.mjs";
const { Schema } = mongoose;

export const AuditEntrySchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, default: null },
    actorType: {
      type: String,
      enum: ["user", "system", "ai"],
      default: "user",
    },
    action: { type: String, required: true },
    targetType: {
      type: String,
      enum: [
        "user",
        "project",
        "job",
        "org",
        "settings",
        "auth",
        "sso-provider",
        "compilation-profile",
      ],
      required: true,
    },
    targetId: { type: String, required: true },
    projectId: { type: Schema.Types.ObjectId, default: null },
    info: { type: Object, default: {} },
    ipAddress: { type: String },
    userAgent: { type: String },
    timestamp: { type: Date, default: Date.now },
  },
  {
    collection: "auditEntries",
    minimize: false,
  },
);

AuditEntrySchema.index({ targetType: 1, targetId: 1, timestamp: -1 });
AuditEntrySchema.index({ actorId: 1, timestamp: -1 });
AuditEntrySchema.index({ action: 1, timestamp: -1 });
AuditEntrySchema.index({ projectId: 1, timestamp: -1 });

export const AuditEntry = mongoose.model("AuditEntry", AuditEntrySchema);
