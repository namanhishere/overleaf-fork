import mongoose from "../infrastructure/Mongoose.mjs";

const { Schema } = mongoose;

// Admin-managed compilation environment. Applying a profile to a project
// sets the project's compiler and TeX Live image; the values actually used
// are snapshotted onto every compile job and release, so builds stay
// traceable without a separate execution path.
const CompilationProfileSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    // Docker image reference for the compile environment, e.g.
    // "texlive-full:2026.08". Empty means the platform default image.
    imageName: { type: String, default: null },
    // pdflatex | latex | xelatex | lualatex. Null means project choice.
    compiler: {
      type: String,
      enum: [null, "pdflatex", "latex", "xelatex", "lualatex"],
      default: null,
    },
    texLiveVersion: { type: String, default: null },
    timeoutMinutes: { type: Number, min: 1, max: 30, default: null },
    description: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, default: null },
  },
  { collection: "compilationProfiles", timestamps: true },
);

export const CompilationProfile = mongoose.model(
  "CompilationProfile",
  CompilationProfileSchema,
);
