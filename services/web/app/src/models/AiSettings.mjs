import mongoose from "../infrastructure/Mongoose.mjs";

const { Schema } = mongoose;

// Global AI provider configuration (single document). OpenAI-compatible
// chat-completions API so any provider (OpenAI, Azure, vLLM, Ollama...)
// works. The API key is write-only.
const AiSettingsSchema = new Schema(
  {
    key: { type: String, default: "global", unique: true },
    enabled: { type: Boolean, default: false },
    baseUrl: { type: String, default: "https://api.openai.com/v1" },
    apiKey: { type: String, default: null },
    model: { type: String, default: "gpt-4o-mini" },
    maxIterations: { type: Number, default: 3, min: 1, max: 10 },
    // Explicit AI permission model (PLANS 10). Dangerous capabilities are
    // denied by default: no file deletion, no git access, no secrets.
    permissions: {
      readFiles: { type: Boolean, default: true },
      writeFiles: { type: Boolean, default: true },
      deleteFiles: { type: Boolean, default: false },
      compile: { type: Boolean, default: true },
      git: { type: Boolean, default: false },
      secrets: { type: Boolean, default: false },
      snapshots: { type: Boolean, default: true },
    },
  },
  { collection: "aiSettings", timestamps: true },
);

export const AiSettings = mongoose.model("AiSettings", AiSettingsSchema);
