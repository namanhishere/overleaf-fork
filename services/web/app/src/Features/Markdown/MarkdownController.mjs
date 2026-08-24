import { expressify } from "@overleaf/promise-utils";
import SessionManager from "../Authentication/SessionManager.mjs";
import MarkdownService from "./MarkdownService.mjs";

// GET /project/:Project_id/api/markdown/:doc_id — doc content for the
// client-side preview renderer.
async function getDoc(req, res) {
  const { Project_id: projectId, doc_id: docId } = req.params;
  const { lines, path: docPath } = await MarkdownService.promises.loadDoc(
    projectId,
    docId,
  );
  res.json({ lines, docPath });
}

// POST /project/:Project_id/api/markdown/:doc_id/convert-to-latex
async function convertToLatex(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const { Project_id: projectId, doc_id: docId } = req.params;
  try {
    const result = await MarkdownService.promises.convertDocToLatex(
      projectId,
      docId,
      userId,
    );
    res.json({ texPath: result.texPath });
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("not a markdown document")) {
      return res.status(400).json({ error: msg });
    }
    throw err;
  }
}

// GET /project/:Project_id/doc/:doc_id/preview — preview page
async function previewPage(req, res) {
  res.render("project/markdown-preview", {
    projectId: req.params.Project_id,
    docId: req.params.doc_id,
  });
}

export default {
  getDoc: expressify(getDoc),
  convertToLatex: expressify(convertToLatex),
  previewPage: expressify(previewPage),
};
