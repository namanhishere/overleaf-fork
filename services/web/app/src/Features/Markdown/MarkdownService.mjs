import OError from "@overleaf/o-error";
import logger from "@overleaf/logger";

/**
 * Minimal, deterministic Markdown -> LaTeX converter covering the common
 * academic-writing subset: headings, emphasis, inline/fenced code, lists,
 * links and paragraphs. All LaTeX-special characters in the source are
 * escaped before structural transforms, so output is always compilable.
 */
export function toLatex(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let listMode = null; // 'itemize' | 'enumerate' | null

  const escapeLatex = (s) =>
    s
      .replace(/\\/g, "\\textbackslash{}")
      .replace(/([&%$#_{}])/g, "\\$1")
      .replace(/~/g, "\\textasciitilde{}")
      .replace(/\^/g, "\\textasciicircum{}");

  const inline = (s) => {
    let t = escapeLatex(s);
    t = t.replace(/`([^`]+)`/g, "\\texttt{$1}");
    t = t.replace(/\*\*([^*]+)\*\*/g, "\\textbf{$1}");
    t = t.replace(/__([^_]+)__/g, "\\textbf{$1}");
    t = t.replace(/\*([^*]+)\*/g, "\\emph{$1}");
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "\\href{$2}{$1}");
    return t;
  };

  const closeList = () => {
    if (listMode) {
      out.push(`\\end{${listMode}}`);
      listMode = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (line.trim().startsWith("```")) {
      if (inCode) {
        out.push("\\end{verbatim}");
        inCode = false;
      } else {
        closeList();
        out.push("\\begin{verbatim}");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(escapeLatex(raw));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      const cmd = ["section", "section", "subsection", "subsubsection"][Math.min(level, 3)];
      out.push(`\\${cmd}{${inline(heading[2])}}`);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listMode !== "itemize") {
        closeList();
        out.push("\\begin{itemize}");
        listMode = "itemize";
      }
      out.push(`\\item ${inline(ul[1])}`);
      continue;
    }

    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listMode !== "enumerate") {
        closeList();
        out.push("\\begin{enumerate}");
        listMode = "enumerate";
      }
      out.push(`\\item ${inline(ol[1])}`);
      continue;
    }

    closeList();

    if (line.trim() === "") {
      out.push("");
      continue;
    }
    out.push(inline(line));
  }
  closeList();
  if (inCode) out.push("\\end{verbatim}");
  return out.join("\n");
}

/**
 * Load a document and convert it to LaTeX, storing the result as a sibling
 * .tex file (same folder, same base name). Audited.
 */
async function convertDocToLatex(projectId, docId, userId) {
  const { lines, path: docPath } = await loadDoc(projectId, docId);
  const markdown = lines.join("\n");
  if (!/\.md$/i.test(docPath)) {
    throw new OError("not a markdown document", { docPath });
  }
  const texPath = docPath.replace(/\.md$/i, ".tex");
  const texLines = toLatex(markdown).split("\n");
  const [{ default: EditorController }, { default: AuditLogManager }] =
    await Promise.all([
      import("../Editor/EditorController.mjs"),
      import("../Audit/AuditLogManager.mjs"),
    ]);
  await EditorController.promises.upsertDocWithPath(
    projectId,
    texPath,
    texLines,
    "markdown-conversion",
    userId,
  );
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: "markdown-converted",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: { after: { docPath, texPath } },
  });
  return { texPath, texLines };
}

async function loadDoc(projectId, docId) {
  const [
    { default: ProjectGetter },
    { default: ProjectLocator },
    { default: ProjectEntityHandler },
  ] = await Promise.all([
    import("../Project/ProjectGetter.mjs"),
    import("../Project/ProjectLocator.mjs"),
    import("../Project/ProjectEntityHandler.mjs"),
  ]);
  const project = await ProjectGetter.promises.getProject(projectId, {
    rootFolder: true,
  });
  if (project == null) {
    throw new OError("project not found", { projectId });
  }
  const { path: elementPath } = await ProjectLocator.promises.findElement({
    project,
    element_id: docId,
    type: "doc",
  });
  const { lines } = await ProjectEntityHandler.promises.getDoc(projectId, docId, {
    peek: true,
  });
  // findElement returns path as { fileSystem, mongo }; expose the readable one
  return { lines, path: elementPath.fileSystem };
}

export default {
  toLatex,
  convertDocToLatex,
  loadDoc,
  promises: {
    toLatex,
    convertDocToLatex,
    loadDoc,
  },
};
