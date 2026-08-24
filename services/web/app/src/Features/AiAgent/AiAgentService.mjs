import OError from "@overleaf/o-error";
import { AiSettings } from "../../models/AiSettings.mjs";
import { AiProposal } from "../../models/AiProposal.mjs";
import ProjectGetter from "../Project/ProjectGetter.mjs";
import ProjectEntityHandler from "../Project/ProjectEntityHandler.mjs";
import EditorController from "../Editor/EditorController.mjs";
import CompileManager from "../Compile/CompileManager.mjs";
import AuditLogManager from "../Audit/AuditLogManager.mjs";
import { fetchString } from "@overleaf/fetch-utils";

const TEXT_EXTENSIONS = /\.(tex|md|txt|bib|sty|cls|clo|latexmkrc)$/i;
const MAX_FILE_CHARS = 40_000;
const MAX_CONTEXT_FILES = 60;

// ---- settings ----

async function getSettings() {
  let doc = await AiSettings.findOne({ key: "global" }).lean().exec();
  if (doc == null) {
    doc = {
      enabled: false,
      baseUrl: null,
      apiKey: null,
      model: null,
      maxIterations: 3,
    };
  }
  return { ...doc, apiKey: doc.apiKey || null };
}

async function saveSettings(body) {
  const patch = {};
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
  if (body.baseUrl != null) patch.baseUrl = String(body.baseUrl).trim();
  if (body.model != null) patch.model = String(body.model).trim();
  if (body.maxIterations != null) {
    patch.maxIterations = Math.min(
      Math.max(parseInt(body.maxIterations, 10) || 3, 1),
      10,
    );
  }
  // apiKey is write-only: only update when a non-empty value arrives
  if (body.apiKey) patch.apiKey = String(body.apiKey);
  await AiSettings.updateOne(
    { key: "global" },
    { $set: patch, $setOnInsert: { key: "global" } },
    { upsert: true },
  );
  return getSettings();
}

// ---- project context ----

function walkFolder(folder, prefix, out) {
  for (const doc of folder.docs || []) {
    out.push({ path: prefix + doc.name, type: "doc", id: String(doc._id) });
  }
  for (const file of folder.fileRefs || []) {
    out.push({ path: prefix + file.name, type: "file", id: String(file._id) });
  }
  for (const child of folder.folders || []) {
    walkFolder(child, `${prefix}${child.name}/`, out);
  }
}

async function listFiles(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    rootFolder: 1,
  });
  if (project == null) throw new OError("project not found", { projectId });
  const out = [];
  for (const root of project.rootFolder || []) walkFolder(root, "", out);
  return out;
}

async function readDocLines(projectId, path) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    rootFolder: 1,
  });
  if (project == null) return null;
  // path is entity-style with a leading slash; match against the
  // fileSystem-style path built during the walk
  const wanted = String(path).replace(/^\//, "");
  let found = null;
  const find = (folder, base) => {
    for (const doc of folder.docs || []) {
      if (base + doc.name === wanted) found = doc;
    }
    for (const child of folder.folders || []) {
      find(child, `${base}${child.name}/`);
    }
  };
  for (const root of project.rootFolder || []) find(root, "");
  if (found == null) return null;
  const { lines } = await ProjectEntityHandler.promises.getDoc(
    projectId,
    found._id,
    { peek: true },
  );
  return lines;
}

async function getProjectContext(projectId) {
  const files = await listFiles(projectId);
  const contextFiles = [];
  for (const f of files.slice(0, MAX_CONTEXT_FILES)) {
    if (f.type !== "doc" || !TEXT_EXTENSIONS.test(f.path)) continue;
    const lines = await readDocLines(projectId, f.path);
    if (lines == null) continue;
    let content = lines.join("\n");
    if (content.length > MAX_FILE_CHARS) {
      content = content.slice(0, MAX_FILE_CHARS) + "\n... (truncated)";
    }
    contextFiles.push({ path: f.path, content });
  }
  return { files: files.map((f) => f.path), contextFiles };
}

// ---- proposals ----

function simpleDiff(previousLines, newLines) {
  const before = previousLines || [];
  const out = [];
  const max = Math.max(before.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const b = before[i];
    const n = newLines[i];
    if (b === n) {
      if (b !== undefined) out.push(`  ${b}`);
    } else {
      if (b !== undefined) out.push(`- ${b}`);
      if (n !== undefined) out.push(`+ ${n}`);
    }
  }
  return out;
}

async function createProposal(projectId, userId, { path, content, summary }) {
  // upsertDocWithPath expects entity paths with a leading slash
  const normalized = "/" + String(path || "").replace(/^\/+/, "");
  path = normalized;
  if (!/^\/[^/]+\.(tex|md|txt|bib)$/i.test(path) || path.includes("..")) {
    throw new OError("invalid target path", { path });
  }
  const previousLines = await readDocLines(projectId, path);
  const proposal = await AiProposal.create({
    projectId,
    userId,
    path,
    previousLines,
    newLines: String(content).split("\n"),
    summary: String(summary || "").slice(0, 500),
  });
  return proposal.toObject();
}

async function applyProposal(projectId, userId, proposalId) {
  const proposal = await AiProposal.findOne({
    _id: proposalId,
    projectId,
    status: "pending",
  });
  if (proposal == null) throw new OError("proposal not found or not pending");
  await EditorController.promises.upsertDocWithPath(
    projectId,
    proposal.path,
    proposal.newLines,
    "ai-agent",
    userId,
  );
  proposal.status = "applied";
  proposal.resolvedAt = new Date();
  await proposal.save();
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: "ai-edit-applied",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: { after: { path: proposal.path, proposalId: String(proposal._id) } },
  });
  return proposal.toObject();
}

async function rejectProposal(projectId, userId, proposalId) {
  const proposal = await AiProposal.findOne({
    _id: proposalId,
    projectId,
    status: "pending",
  });
  if (proposal == null) throw new OError("proposal not found or not pending");
  proposal.status = "rejected";
  proposal.resolvedAt = new Date();
  await proposal.save();
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: "ai-edit-rejected",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: { path: proposal.path },
  });
  return proposal.toObject();
}

async function listProposals(projectId, { includeResolved = false } = {}) {
  const query = includeResolved
    ? { projectId }
    : { projectId, status: "pending" };
  return AiProposal.find(query).sort({ createdAt: -1 }).limit(50).lean().exec();
}

// ---- agent loop (OpenAI-compatible chat completions with tools) ----

function toolDefs() {
  return [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List all file paths in the project.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the contents of a project file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "propose_write_file",
        description:
          "Propose new content for a file. The human must approve the change before it is applied. Use for editing .tex/.md files or creating new ones.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            summary: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "compile_project",
        description: "Compile the project and report the status.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "get_compile_log",
        description: "Get the log excerpt of the most recent compile.",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
}

async function chatCompletion(settings, messages) {
  const raw = await fetchString(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey || ""}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      tools: toolDefs(),
    }),
  });
  return JSON.parse(raw);
}

async function runAgent(projectId, userId, task) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.baseUrl || !settings.apiKey) {
    throw new OError("AI is not configured");
  }
  const maxIterations = settings.maxIterations || 3;

  // Slash commands (PLANS 9): deterministic, no agent loop.
  const trimmed = String(task).trim();
  if (trimmed === "/summarize-comments") {
    const { summary, unresolved } = await summarizeComments(projectId);
    return {
      transcript: [{ role: "assistant", content: summary }],
      proposals: [],
      compile: null,
      iterations: 0,
      unresolvedComments: unresolved,
    };
  }

  const context = await getProjectContext(projectId);
  const systemPrompt = [
    "You are an academic writing and LaTeX assistant working inside an Overleaf-style project.",
    "Project files: " + JSON.stringify(context.files),
    "You can read files, propose file changes (the human approves them), compile, and read compile logs.",
    "Never invent citations. Keep LaTeX valid. Be concise.",
    "Project content:",
    ...context.contextFiles.map((f) => `--- ${f.path} ---\n${f.content}`),
  ].join("\n");

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: String(task).slice(0, 4000) },
  ];

  const transcript = [];
  const proposals = [];
  const latestCompile = { status: null };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await chatCompletion(settings, messages);
    const message = response.choices?.[0]?.message;
    if (message == null) throw new OError("empty AI response");

    if (message.tool_calls && message.tool_calls.length > 0) {
      messages.push(message);
      for (const call of message.tool_calls) {
        let result;
        let proposal = null;
        try {
          const args = JSON.parse(call.function.arguments || "{}");
          switch (call.function.name) {
            case "list_files":
              result = { files: context.files };
              break;
            case "read_file": {
              const lines = await readDocLines(projectId, args.path);
              result =
                lines == null
                  ? { error: "file not found" }
                  : { content: lines.join("\n").slice(0, MAX_FILE_CHARS) };
              break;
            }
            case "propose_write_file": {
              proposal = await createProposal(projectId, userId, args);
              proposals.push(proposal);
              result = {
                ok: true,
                proposalId: String(proposal._id),
                note: "proposal created; the human must approve it",
              };
              break;
            }
            case "compile_project": {
              const limits = { timeout: 60 };
              const result2 = await CompileManager.promises
                .compile(projectId, userId, { timeout: limits.timeout })
                .catch((err) => ({
                  status: "error",
                  error: String(err.message),
                }));
              latestCompile.status = result2.status;
              result = { status: result2.status };
              break;
            }
            case "get_compile_log": {
              const job = await (
                await import("../Compile/CompileJobManager.mjs")
              ).default.promises.listForProject(projectId, { limit: 1 });
              result = {
                logExcerpt: job[0]?.logExcerpt
                  ? String(job[0].logExcerpt).slice(-3000)
                  : "no compile log available",
              };
              break;
            }
            default:
              result = { error: "unknown tool" };
          }
        } catch (err) {
          result = { error: String(err?.message || err).slice(0, 300) };
        }
        transcript.push({
          tool: call.function.name,
          args: call.function.arguments,
          result: JSON.stringify(result).slice(0, 2000),
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 4000),
        });
      }
      continue; // let the model continue with tool results
    }

    // final assistant message
    transcript.push({ assistant: message.content });
    messages.push({ role: "assistant", content: message.content || "" });
    break;
  }

  return {
    transcript,
    proposals: proposals.map((p) => ({
      _id: String(p._id),
      path: p.path,
      status: p.status,
      summary: p.summary,
    })),
    iterationsUsed: transcript.length,
  };
}

// ---- /init (deterministic project context generation) ----

async function generateInitDoc(projectId, userId) {
  const files = await listFiles(projectId);
  const lines = [
    "# Project context (generated by /init)",
    "",
    "## Files",
    "",
    ...files.map(
      (f) => `- ${f.path}${f.type === "file" ? " (binary file)" : ""}`,
    ),
    "",
    "## Conventions",
    "",
    "- Main document: main.tex (adjust if different)",
    "- Do not modify bibliography entries without approval",
    "- Do not change equations without approval",
    "- Preserve existing terminology",
    "",
    "## Notes",
    "",
    "- Edit this file to give AI assistants persistent project context.",
  ];
  await EditorController.promises.upsertDocWithPath(
    projectId,
    "agents.md",
    lines,
    "ai-init",
    userId,
  );
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: "ai-init",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: { after: { path: "agents.md" } },
  });
  return { path: "agents.md", lines };
}

/**
 * AI summary of unresolved review comments (PLANS 9 "AI summarize").
 * Uses the configured chat-completions endpoint; read-only over review
 * state, no tools, single call.
 */
async function summarizeComments(projectId) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.baseUrl || !settings.apiKey) {
    throw new OError("AI is not configured");
  }
  const ReviewService = (await import("../Review/ReviewService.mjs")).default;
  const status = await ReviewService.promises.getReviewStatus(projectId);
  if (status.total === 0) {
    return { summary: "No review comments in this project.", unresolved: 0 };
  }
  const listing = status.threads
    .map(
      (t) => `- [${t.resolved ? "resolved" : "unresolved"}] ${t.firstMessage}`,
    )
    .join("\n");
  const raw = await fetchString(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey || ""}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: "system",
          content:
            "Summarize the state of review comments for this academic writing project in 2-4 short sentences. Mention themes and the most urgent item. Do not invent comments.",
        },
        {
          role: "user",
          content: `Total: ${status.total}, unresolved: ${status.unresolved}.\n${listing}`,
        },
      ],
    }),
  });
  const parsed = JSON.parse(raw);
  const summary =
    parsed.choices?.[0]?.message?.content || "Summary unavailable.";
  return { summary, unresolved: status.unresolved, total: status.total };
}

export default {
  summarizeComments,
  getSettings,
  saveSettings,
  runAgent,
  createProposal,
  applyProposal,
  rejectProposal,
  listProposals,
  generateInitDoc,
  getProjectContext,
  simpleDiff,
  promises: {
    summarizeComments,
    getSettings,
    saveSettings,
    runAgent,
    createProposal,
    applyProposal,
    rejectProposal,
    listProposals,
    generateInitDoc,
    getProjectContext,
    simpleDiff,
  },
};
