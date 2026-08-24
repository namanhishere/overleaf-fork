import OError from "@overleaf/o-error";
import LineDiff from "../../infrastructure/LineDiff.mjs";
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
  return {
    ...doc,
    apiKey: doc.apiKey || null,
    permissions: {
      readFiles: true,
      writeFiles: true,
      deleteFiles: false,
      compile: true,
      git: false,
      secrets: false,
      snapshots: true,
      ...(doc.permissions || {}),
    },
  };
}

// tool name -> permission key (PLANS 10 permission model)
const TOOL_PERMISSIONS = {
  list_files: "readFiles",
  read_file: "readFiles",
  search_files: "readFiles",
  propose_write_file: "writeFiles",
  propose_delete_file: "deleteFiles",
  compile_project: "compile",
  get_compile_log: "readFiles",
  inspect_pdf: "compile",
  git_status: "git",
  git_diff: "git",
  create_snapshot: "snapshots",
  restore_snapshot: "snapshots",
  list_secrets: "secrets",
};

function toolAllowed(toolName, permissions) {
  const key = TOOL_PERMISSIONS[toolName];
  if (key == null) return false;
  return permissions[key] === true;
}

// ---- additional tool implementations ----

async function searchFiles(projectId, query) {
  const needle = String(query || "").toLowerCase();
  if (!needle) return [];
  const files = await listFiles(projectId);
  const matches = [];
  for (const f of files) {
    if (f.type !== "doc" || matches.length >= 20) continue;
    const lines = await readDocLines(projectId, f.path);
    if (lines == null) continue;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        matches.push({
          path: f.path,
          line: i + 1,
          text: lines[i].slice(0, 200),
        });
        if (matches.length >= 20) break;
      }
    }
  }
  return matches;
}

async function createDeleteProposal(projectId, userId, { path, summary }) {
  const normalized = "/" + String(path || "").replace(/^\/+/, "");
  if (
    !/^\/[^/]+\.(tex|md|txt|bib)$/i.test(normalized) ||
    normalized.includes("..")
  ) {
    throw new OError("invalid target path", { path });
  }
  const previousLines = await readDocLines(projectId, normalized);
  if (previousLines == null) throw new OError("file not found", { path });
  const proposal = await AiProposal.create({
    projectId,
    userId,
    path: normalized,
    previousLines,
    newLines: [],
    action: "delete",
    summary: String(summary || "delete file").slice(0, 500),
  });
  return proposal.toObject();
}

async function getGitStatus(projectId) {
  const GitIntegrationService = (
    await import("../GitIntegration/GitIntegrationService.mjs")
  ).default;
  return GitIntegrationService.promises.getGitInfo(projectId, null);
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
  if (body.permissions && typeof body.permissions === "object") {
    const allowed = [
      "readFiles",
      "writeFiles",
      "deleteFiles",
      "compile",
      "git",
      "secrets",
      "snapshots",
    ];
    const perms = {};
    for (const key of allowed) {
      if (body.permissions[key] !== undefined) {
        perms[`permissions.${key}`] = Boolean(body.permissions[key]);
      }
    }
    Object.assign(patch, perms);
  }
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
  const newLines = String(content).split("\n");
  const hunks = LineDiff.computeHunks(previousLines, newLines);
  const proposal = await AiProposal.create({
    projectId,
    userId,
    path,
    previousLines,
    newLines,
    hunks,
    action: "write",
    summary: String(summary || "").slice(0, 500),
  });
  return proposal.toObject();
}

// Rebuild the resulting content when only a subset of hunks is accepted
// (PLANS 11 partial accept): rejected hunks keep their previous lines.
function contentForHunks(proposal, acceptedIndices) {
  const a = proposal.previousLines || [];
  const hunks = proposal.hunks || [];
  const accepted = new Set(acceptedIndices);
  const out = [];
  let pi = 0;
  hunks.forEach((h, idx) => {
    while (pi < h.beforeStart && pi < a.length) out.push(a[pi++]);
    if (accepted.has(idx)) out.push(...h.afterLines);
    else out.push(...h.beforeLines);
    pi = h.beforeStart + h.beforeLines.length;
  });
  while (pi < a.length) out.push(a[pi++]);
  return out;
}

async function applyProposal(projectId, userId, proposalId, { hunks } = {}) {
  const proposal = await AiProposal.findOne({
    _id: proposalId,
    projectId,
    status: "pending",
  });
  if (proposal == null) throw new OError("proposal not found or not pending");
  const partial =
    Array.isArray(hunks) &&
    hunks.length > 0 &&
    hunks.length < (proposal.hunks || []).length;
  if (hunks != null && !partial && (proposal.hunks || []).length > 0) {
    // full selection supplied
  }
  const acceptedHunks = partial ? hunks : null;
  if (proposal.action === "delete") {
    await EditorController.promises.deleteEntityWithPath(
      projectId,
      proposal.path,
      "ai-agent",
      userId,
    );
  } else if (partial) {
    const merged = contentForHunks(proposal, hunks);
    await EditorController.promises.upsertDocWithPath(
      projectId,
      proposal.path,
      merged,
      "ai-agent",
      userId,
    );
  } else {
    await EditorController.promises.upsertDocWithPath(
      projectId,
      proposal.path,
      proposal.newLines,
      "ai-agent",
      userId,
    );
  }
  proposal.status = "applied";
  proposal.appliedHunks = acceptedHunks;
  proposal.resolvedAt = new Date();
  await proposal.save();
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: "ai-edit-applied",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: {
      after: { path: proposal.path, proposalId: String(proposal._id) },
      partial,
      acceptedHunks: acceptedHunks || "all",
    },
  });
  return proposal.toObject();
}

// Undo an applied write proposal (PLANS 11): restores previousLines.
// Refuses when the document has been modified since the apply, so a
// later human/AI edit is never clobbered.
async function undoProposal(projectId, userId, proposalId) {
  const proposal = await AiProposal.findOne({
    _id: proposalId,
    projectId,
    status: "applied",
  });
  if (proposal == null) throw new OError("proposal not found or not applied");
  if (proposal.action === "delete") {
    throw new OError(
      "delete proposals cannot be undone; restore the file from history",
    );
  }
  const current = await readDocLines(projectId, proposal.path);
  const expected =
    proposal.appliedHunks != null
      ? contentForHunks(proposal, proposal.appliedHunks)
      : proposal.newLines;
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new OError("document changed since apply; undo refused", {
      path: proposal.path,
    });
  }
  await EditorController.promises.upsertDocWithPath(
    projectId,
    proposal.path,
    proposal.previousLines || [],
    "ai-agent",
    userId,
  );
  proposal.status = "undone";
  proposal.resolvedAt = new Date();
  await proposal.save();
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: "ai-edit-undone",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: { path: proposal.path, proposalId: String(proposal._id) },
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

function toolDefs(permissions) {
  const defs = {
    list_files: {
      type: "function",
      function: {
        name: "list_files",
        description: "List all file paths in the project.",
        parameters: { type: "object", properties: {} },
      },
    },
    read_file: {
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
    search_files: {
      type: "function",
      function: {
        name: "search_files",
        description:
          "Search all project files for a case-insensitive substring.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
    propose_write_file: {
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
    propose_delete_file: {
      type: "function",
      function: {
        name: "propose_delete_file",
        description:
          "Propose deleting a file. The human must approve the deletion before it is applied.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            summary: { type: "string" },
          },
          required: ["path"],
        },
      },
    },
    compile_project: {
      type: "function",
      function: {
        name: "compile_project",
        description: "Compile the project and report the status.",
        parameters: { type: "object", properties: {} },
      },
    },
    get_compile_log: {
      type: "function",
      function: {
        name: "get_compile_log",
        description: "Get the log excerpt of the most recent compile.",
        parameters: { type: "object", properties: {} },
      },
    },
    inspect_pdf: {
      type: "function",
      function: {
        name: "inspect_pdf",
        description:
          "List the output files (including the PDF) of the most recent compile with sizes.",
        parameters: { type: "object", properties: {} },
      },
    },
    git_status: {
      type: "function",
      function: {
        name: "git_status",
        description:
          "Report the git integration status and clone URL for this project.",
        parameters: { type: "object", properties: {} },
      },
    },
    git_diff: {
      type: "function",
      function: {
        name: "git_diff",
        description:
          "Report how to diff project changes with git (the platform delegates diffs to git itself).",
        parameters: { type: "object", properties: {} },
      },
    },
    create_snapshot: {
      type: "function",
      function: {
        name: "create_snapshot",
        description:
          "Create an immutable release snapshot of the latest successful compile. Requires a tag.",
        parameters: {
          type: "object",
          properties: {
            tag: { type: "string" },
            notes: { type: "string" },
          },
          required: ["tag"],
        },
      },
    },
    list_secrets: {
      type: "function",
      function: {
        name: "list_secrets",
        description:
          "List the NAMES of the project's configured secrets. Values are never exposed to the agent.",
        parameters: { type: "object", properties: {} },
      },
    },
    restore_snapshot: {
      type: "function",
      function: {
        name: "restore_snapshot",
        description:
          "Propose restoring a file's content from a project history version. The human must approve the restore.",
        parameters: {
          type: "object",
          properties: {
            version: { type: "number" },
            path: { type: "string" },
          },
          required: ["version", "path"],
        },
      },
    },
  };
  return Object.entries(defs)
    .filter(([name]) => toolAllowed(name, permissions))
    .map(([, def]) => def);
}

async function chatCompletion(settings, messages, tools = [], meta = {}) {
  const raw = await fetchString(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey || ""}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      tools,
    }),
  });
  const parsed = JSON.parse(raw);
  // record usage for observability (PLANS 18); never block on failure
  try {
    const usage = parsed.usage || {};
    if (usage.prompt_tokens != null || usage.completion_tokens != null) {
      const { AiUsage } = await import("../../models/AiUsage.mjs");
      await AiUsage.create({
        model: settings.model || "unknown",
        purpose: meta.purpose || "other",
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        projectId: meta.projectId || undefined,
      });
    }
  } catch {
    // usage tracking must never break agent runs
  }
  return parsed;
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

  const permissions = settings.permissions;
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

  const tools = toolDefs(permissions);
  const transcript = [];
  const proposals = [];
  const latestCompile = { status: null };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await chatCompletion(settings, messages, tools, {
      purpose: "agent",
      projectId,
    });
    const message = response.choices?.[0]?.message;
    if (message == null) throw new OError("empty AI response");

    if (message.tool_calls && message.tool_calls.length > 0) {
      messages.push(message);
      for (const call of message.tool_calls) {
        let result;
        let proposal = null;
        try {
          const args = JSON.parse(call.function.arguments || "{}");
          if (!toolAllowed(call.function.name, permissions)) {
            result = {
              denied: true,
              error: `tool "${call.function.name}" is denied by the AI permission policy`,
            };
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
            continue;
          }
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
              latestCompile.outputFiles = result2.outputFiles || null;
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
            case "search_files": {
              result = { matches: await searchFiles(projectId, args.query) };
              break;
            }
            case "propose_delete_file": {
              proposal = await createDeleteProposal(projectId, userId, args);
              proposals.push(proposal);
              result = {
                ok: true,
                proposalId: String(proposal._id),
                note: "delete proposal created; the human must approve it",
              };
              break;
            }
            case "inspect_pdf": {
              result =
                latestCompile.outputFiles == null
                  ? { error: "no compile has run in this session" }
                  : {
                      outputFiles: latestCompile.outputFiles.map((f) => ({
                        path: f.path,
                        size: f.size,
                      })),
                    };
              break;
            }
            case "git_status": {
              result = await getGitStatus(projectId);
              break;
            }
            case "git_diff": {
              const info = await getGitStatus(projectId);
              result = info.enabled
                ? {
                    available: true,
                    cloneUrl: info.cloneUrl,
                    note: "run git diff in a clone; the platform delegates diffs to git",
                  }
                : {
                    available: false,
                    note:
                      info.cloneUrl === null
                        ? "git integration is not configured for this deployment"
                        : "git integration is disabled",
                  };
              break;
            }
            case "create_snapshot": {
              const ProjectReleasesManager = (
                await import("../Releases/ProjectReleasesManager.mjs")
              ).default;
              const release =
                await ProjectReleasesManager.promises.createRelease(projectId, {
                  tag: args.tag,
                  notes: args.notes || "created by AI agent",
                  userId,
                });
              result = {
                ok: true,
                releaseId: String(release._id),
                tag: release.tag,
              };
              break;
            }
            case "list_secrets": {
              const SecretsService = (
                await import("../Secrets/SecretsService.mjs")
              ).default;
              const secrets =
                await SecretsService.promises.listSecrets(projectId);
              // names only: values must never enter transcripts or logs
              result = {
                secrets: (secrets || []).map((x) => x.key),
                note: "values are never exposed to the agent",
              };
              break;
            }
            case "restore_snapshot": {
              const HistoryManager = (
                await import("../History/HistoryManager.mjs")
              ).default;
              const content = await HistoryManager.promises.getContentAtVersion(
                projectId,
                args.version,
              );
              const entry = (content.files || []).find(
                (f) => f.path === String(args.path).replace(/^\/+/, ""),
              );
              if (entry == null) {
                result = { error: "path not found at that version" };
                break;
              }
              const text = Array.isArray(entry.content?.lines)
                ? entry.content.lines.join("\n")
                : String(entry.content ?? "");
              proposal = await createProposal(projectId, userId, {
                path: args.path,
                content: text,
                summary: `restore from version ${args.version}`,
              });
              proposals.push(proposal);
              result = {
                ok: true,
                proposalId: String(proposal._id),
                note: "restore proposal created; the human must approve it",
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

  // PLANS 13: when the loop stops, present the final compile state —
  // status plus the last log excerpt — alongside attempts and proposals.
  let finalLog = null;
  const relevantFiles = new Set();
  if (latestCompile.status != null) {
    try {
      const job = await (
        await import("../Compile/CompileJobManager.mjs")
      ).default.promises.listForProject(projectId, { limit: 1 });
      finalLog = job[0]?.logExcerpt
        ? String(job[0].logExcerpt).slice(-3000)
        : null;
      // PLANS 13 "relevant files": files the log blames for errors
      if (finalLog) {
        for (const m of finalLog.matchAll(/([\w./\-]+\.tex|\w+\.bib)/g)) {
          relevantFiles.add(m[1].replace(/^\.\//, ""));
        }
      }
    } catch {
      finalLog = null;
    }
  }

  return {
    transcript,
    proposals: proposals.map((p) => ({
      _id: String(p._id),
      path: p.path,
      status: p.status,
      summary: p.summary,
    })),
    compile: {
      status: latestCompile.status,
      logExcerpt: finalLog,
      relevantFiles: [...relevantFiles],
    },
    iterationsUsed: transcript.length,
  };
}

// ---- /init (deterministic project context generation) ----

async function generateInitDoc(projectId, userId) {
  const files = await listFiles(projectId);

  // Analyze the main document for language, class and citation style
  // (PLANS 12: the generated context describes these).
  const mainDoc = files.find((f) => f.path === "main.tex");
  let documentClass = null;
  let citationStyle = null;
  let language = "English";
  if (mainDoc && mainDoc.type === "doc") {
    const lines = (await readDocLines(projectId, mainDoc.path)) || [];
    const text = lines.join("\n");
    const cls = text.match(/\\documentclass(?:\[[^\]]*\])?\{(\w+)\}/);
    documentClass = cls ? cls[1] : null;
    const bib = text.match(/\\bibliographystyle\{(\w+)\}/);
    citationStyle = bib ? bib[1] : null;
    const lang = text.match(/\\usepackage\[[^\]]*shorthand[^\]]*\]/)
      ? null
      : null;
    if (/\\usepackage\[\w*\]?\{babel\}/.test(text)) {
      const babel = text.match(/\\usepackage(?:\[([^\]]*)\])?\{babel\}/);
      if (babel && babel[1]) language = babel[1].split(",")[0].trim();
    }
  }

  const bibFiles = files.filter((f) => f.path.endsWith(".bib"));
  const texFiles = files.filter(
    (f) => f.path.endsWith(".tex") && f.path !== "main.tex",
  );

  const lines = [
    "# Project context (generated by /init)",
    "",
    "## Overview",
    "",
    `Language: ${language}`,
    documentClass ? `Document class: ${documentClass}` : null,
    citationStyle ? `Citation style: ${citationStyle}` : null,
    bibFiles.length > 0
      ? `Bibliography: ${bibFiles.map((f) => f.path).join(", ")}`
      : "Bibliography: none detected",
    "",
    "## Files",
    "",
    ...files.map(
      (f) => `- ${f.path}${f.type === "file" ? " (binary file)" : ""}`,
    ),
    "",
    "## Structure",
    "",
    `- Main document: main.tex${texFiles.length > 0 ? " (includes/inputs: " + texFiles.map((f) => f.path).join(", ") + ")" : ""}`,
    "",
    "## Constraints",
    "",
    "- Do not invent citations",
    "- Do not modify bibliography entries without approval",
    "- Do not change equations without approval",
    "- Preserve existing terminology",
    "- Do not modify agents.md itself without approval",
    "",
    "## Notes",
    "",
    "- Edit this file to give AI assistants persistent project context.",
    "- Author preferences and research-specific instructions belong here.",
  ].filter((l) => l !== null);
  const written = [{ path: "agents.md", lines }];
  await EditorController.promises.upsertDocWithPath(
    projectId,
    "/agents.md",
    lines,
    "ai-init",
    userId,
  );
  if (bibFiles.length > 0) {
    const bibLines = [
      "# Bibliography context (generated by /init)",
      "",
      `Citation style: ${citationStyle || "not detected"}`,
      `Bibliography files: ${bibFiles.map((f) => f.path).join(", ")}`,
      "",
      "## Constraints",
      "",
      "- Do not invent citations",
      "- Do not modify bibliography entries without approval",
      "- Verify every citation exists in the .bib files",
    ];
    await EditorController.promises.upsertDocWithPath(
      projectId,
      "/bibliography.md",
      bibLines,
      "ai-init",
      userId,
    );
    written.push({ path: "bibliography.md", lines: bibLines });
  }
  {
    const constraintLines = [
      "# Formatting constraints (generated by /init)",
      "",
      "- Do not invent citations",
      "- Do not modify bibliography entries without approval",
      "- Do not change equations without approval",
      "- Preserve existing terminology",
      "- Keep LaTeX compilable: run a compile after structural edits",
      "- Do not modify agents.md or this file without approval",
      "",
      "Add project-specific constraints below.",
    ];
    await EditorController.promises.upsertDocWithPath(
      projectId,
      "/constraints.md",
      constraintLines,
      "ai-init",
      userId,
    );
    written.push({ path: "constraints.md", lines: constraintLines });
  }
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: "ai-init",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: { after: { path: "agents.md" } },
  });
  return { path: "agents.md", lines, files: written.map((w) => w.path) };
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
  const parsed = await chatCompletion(
    { ...settings, model: settings.model },
    [
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
    [],
    { purpose: "summarize", projectId },
  );
  const summary =
    parsed.choices?.[0]?.message?.content || "Summary unavailable.";
  return { summary, unresolved: status.unresolved, total: status.total };
}

// Render a unified-ish diff from stored hunks
function hunkDiff(hunks, previousLines) {
  return LineDiff.renderDiff(hunks || [], previousLines, []);
}

export default {
  summarizeComments,
  getSettings,
  saveSettings,
  runAgent,
  createProposal,
  applyProposal,
  undoProposal,
  rejectProposal,
  listProposals,
  generateInitDoc,
  getProjectContext,
  simpleDiff,
  hunkDiff,
  promises: {
    summarizeComments,
    getSettings,
    saveSettings,
    runAgent,
    createProposal,
    applyProposal,
    undoProposal,
    rejectProposal,
    listProposals,
    generateInitDoc,
    getProjectContext,
    simpleDiff,
    hunkDiff,
  },
};
