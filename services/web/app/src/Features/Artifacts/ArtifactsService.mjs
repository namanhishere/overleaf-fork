import path from "node:path";
import OError from "@overleaf/o-error";
import ProjectGetter from "../Project/ProjectGetter.mjs";
import EditorController from "../Editor/EditorController.mjs";

// Research artifact categories (PLANS 14): data, figures, code and other
// binary files, distinguished from LaTeX/markdown source documents.
const CATEGORIES = {
  data: [".csv", ".tsv", ".json", ".xlsx", ".parquet", ".h5", ".hdf5", ".dat"],
  figure: [
    ".png",
    ".jpg",
    ".jpeg",
    ".svg",
    ".gif",
    ".pdf",
    ".eps",
    ".tif",
    ".tiff",
  ],
  code: [".py", ".r", ".m", ".js", ".ipynb", ".sh", ".do"],
  doc: [".tex", ".md", ".txt", ".bib"],
};

const SOURCE_EXTENSIONS = new Set([
  ".tex",
  ".md",
  ".txt",
  ".bib",
  ".sty",
  ".cls",
  ".latexmkrc",
]);

export function categorize(name) {
  const ext = path.extname(name).toLowerCase();
  for (const [category, exts] of Object.entries(CATEGORIES)) {
    if (exts.includes(ext)) return category;
  }
  return "other";
}

function walkFolder(folder, prefix, out) {
  for (const doc of folder.docs || []) {
    out.push({
      path: prefix + doc.name,
      type: "doc",
      id: String(doc._id),
      created: doc.created,
    });
  }
  for (const file of folder.fileRefs || []) {
    out.push({
      path: prefix + file.name,
      type: "file",
      id: String(file._id),
      created: file.created,
      linked: file.linkedFileData != null,
    });
  }
  for (const child of folder.folders || []) {
    walkFolder(child, `${prefix}${child.name}/`, out);
  }
}

/**
 * List research artifacts: every non-source file in the project, grouped
 * by category. Source documents (.tex/.md/...) are excluded — they are
 * the paper, not artifacts about it.
 */
async function listArtifacts(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    rootFolder: 1,
  });
  if (project == null) throw new OError("project not found", { projectId });
  const all = [];
  for (const root of project.rootFolder || []) walkFolder(root, "", all);
  const artifacts = all
    .filter(
      (f) =>
        f.type === "file" &&
        !SOURCE_EXTENSIONS.has(path.extname(f.path).toLowerCase()),
    )
    .map((f) => ({ ...f, category: categorize(f.path) }));
  const byCategory = {};
  for (const a of artifacts) {
    byCategory[a.category] ??= [];
    byCategory[a.category].push(a);
  }
  return { artifacts, byCategory, total: artifacts.length };
}

/**
 * Ensure an `artifacts` folder exists at the project root and return its
 * id, so uploads land in a consistent project structure.
 */
async function ensureArtifactsFolder(projectId, userId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    rootFolder: 1,
  });
  if (project == null) throw new OError("project not found", { projectId });
  const root = project.rootFolder[0];
  const existing = (root.folders || []).find((f) => f.name === "artifacts");
  if (existing) return String(existing._id);
  const folder = await EditorController.promises.addFolder(
    projectId,
    root._id,
    "artifacts",
    "artifacts-page",
    userId,
  );
  return String(folder._id);
}

export default {
  categorize,
  listArtifacts,
  ensureArtifactsFolder,
  promises: { listArtifacts, ensureArtifactsFolder },
};
