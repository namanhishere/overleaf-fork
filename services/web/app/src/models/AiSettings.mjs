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
  },
  { collection: "aiSettings", timestamps: true },
);

export const AiSettings = mongoose.model("AiSettings", AiSettingsSchema);
