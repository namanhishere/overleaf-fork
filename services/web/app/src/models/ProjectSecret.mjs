import mongoose from "../infrastructure/Mongoose.mjs";

const { Schema } = mongoose

// Project-level secret. Values are AES-256-GCM encrypted at rest and are
// never returned by any API: only names and metadata are readable.
const ProjectSecretSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    // Secret name, e.g. "ZENODO_TOKEN". Uppercase env-style identifier.
    key: { type: String, required: true },
    // value:v1:<iv-b64>:<tag-b64>:<ciphertext-b64>
    valueEncrypted: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, default: null },
  },
  { collection: "projectSecrets", timestamps: true },
)

ProjectSecretSchema.index({ projectId: 1, key: 1 }, { unique: true })

export const ProjectSecret = mongoose.model(
  'ProjectSecret',
  ProjectSecretSchema
)
