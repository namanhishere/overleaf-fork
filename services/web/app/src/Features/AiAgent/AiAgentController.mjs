import { expressify } from "@overleaf/promise-utils";
import SessionManager from "../Authentication/SessionManager.mjs";
import AuthorizationMiddleware from "../Authorization/AuthorizationMiddleware.mjs";
import AiAgentService from "./AiAgentService.mjs";

function _userId(req) {
  return SessionManager.getLoggedInUserId(req.session);
}

// ---- admin ----

// GET /admin/api/ai
async function getSettings(req, res) {
  const settings = await AiAgentService.promises.getSettings();
  res.json({
    settings: { ...settings, apiKey: settings.apiKey ? "saved" : null },
  });
}

// PUT /admin/api/ai
async function saveSettings(req, res) {
  const settings = await AiAgentService.promises.saveSettings(req.body || {});
  res.json({
    settings: { ...settings, apiKey: settings.apiKey ? "saved" : null },
  });
}

// ---- project ----

// POST /project/:Project_id/api/ai/run  { task }
async function runAgent(req, res) {
  const projectId = req.params.Project_id;
  const userId = _userId(req);
  try {
    const result = await AiAgentService.promises.runAgent(
      projectId,
      userId,
      req.body?.task || "",
    );
    res.json(result);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("AI is not configured")) {
      return res.status(400).json({ error: msg });
    }
    throw err;
  }
}

// GET /project/:Project_id/api/ai/proposals
async function listProposals(req, res) {
  const proposals = await AiAgentService.promises.listProposals(
    req.params.Project_id,
    { includeResolved: req.query.all === "true" },
  );
  res.json({
    proposals: proposals.map((p) => ({
      ...p,
      diff:
        p.hunks && p.hunks.length > 0
          ? AiAgentService.hunkDiff(p.hunks, p.previousLines)
          : AiAgentService.simpleDiff(p.previousLines, p.newLines),
    })),
  });
}

// POST /project/:Project_id/api/ai/proposals/:proposalId/undo
async function undoProposal(req, res) {
  const proposal = await AiAgentService.promises.undoProposal(
    req.params.Project_id,
    _userId(req),
    req.params.proposalId,
  );
  res.json({ proposal });
}

// POST /project/:Project_id/api/ai/proposals/:proposalId/apply
async function applyProposal(req, res) {
  const hunks = req.body && req.body.hunks;
  const proposal = await AiAgentService.promises.applyProposal(
    req.params.Project_id,
    _userId(req),
    req.params.proposalId,
    { hunks: Array.isArray(hunks) ? hunks.map(Number) : undefined },
  );
  res.json({ proposal });
}

// POST /project/:Project_id/api/ai/proposals/:proposalId/reject
async function rejectProposal(req, res) {
  const proposal = await AiAgentService.promises.rejectProposal(
    req.params.Project_id,
    _userId(req),
    req.params.proposalId,
  );
  res.json({ proposal });
}

// POST /project/:Project_id/api/ai/init
async function init(req, res) {
  const result = await AiAgentService.promises.generateInitDoc(
    req.params.Project_id,
    _userId(req),
  );
  res.json({ path: result.path });
}

export default {
  getSettings: expressify(getSettings),
  saveSettings: expressify(saveSettings),
  runAgent: expressify(runAgent),
  listProposals: expressify(listProposals),
  applyProposal: expressify(applyProposal),
  undoProposal: expressify(undoProposal),
  rejectProposal: expressify(rejectProposal),
  init: expressify(init),
};
