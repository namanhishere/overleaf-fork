import OError from "@overleaf/o-error";
import ChatApiHandler from "../Chat/ChatApiHandler.mjs";
import ProjectGetter from "../Project/ProjectGetter.mjs";
import { Project } from "../../models/Project.mjs";
import CollaboratorsGetter from "../Collaborators/CollaboratorsGetter.mjs";
import UserGetter from "../User/UserGetter.mjs";
import AuditLogManager from "../Audit/AuditLogManager.mjs";

/**
 * Review status for a project: every comment thread with its resolved
 * state and a generated summary (PLANS 9).
 */
async function getReviewStatus(projectId) {
  const [threads, resolvedIds] = await Promise.all([
    ChatApiHandler.promises.getThreads(projectId),
    ChatApiHandler.promises.getResolvedThreadIds(projectId),
  ]);
  const resolvedSet = new Set(resolvedIds || []);
  const entries = [];
  for (const [threadId, thread] of Object.entries(threads || {})) {
    const messages = thread.messages || [];
    if (messages.length === 0) continue;
    const first = messages[0];
    entries.push({
      threadId,
      resolved: thread.resolved != null || resolvedSet.has(threadId),
      resolvedBy: thread.resolved?.user_id || null,
      messageCount: messages.length,
      firstMessage: String(first.content || "").slice(0, 200),
      createdBy: first.user_id || null,
      lastActivity: messages[messages.length - 1]?.timestamp || null,
    });
  }
  entries.sort((a, b) => {
    // unresolved first, then most recently active
    if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
    return String(b.lastActivity).localeCompare(String(a.lastActivity));
  });

  // Mentions (PLANS 9): detect @<member name> references in thread
  // messages and map them to member ids.
  let members = [];
  try {
    const memberIds =
      await CollaboratorsGetter.promises.getMemberIds(projectId);
    members = await UserGetter.promises.getUsers(memberIds || []);
  } catch {
    members = [];
  }
  const byFirstName = new Map();
  const byFullName = new Map();
  const index = (m) => {
    if (m == null) return;
    const name =
      [m.first_name, m.last_name].filter(Boolean).join(" ") ||
      m.name ||
      m.email ||
      "";
    const parts = String(name).trim().split(/\s+/);
    if (parts[0]) byFirstName.set(parts[0].toLowerCase(), m);
    if (parts.length > 1) byFullName.set(parts.join(" ").toLowerCase(), m);
  };
  for (const m of members) index(m);
  const project = await ProjectGetter.promises.getProject(projectId, {
    owner_ref: 1,
  });
  if (project?.owner_ref) {
    try {
      const owners = await UserGetter.promises.getUsers([project.owner_ref]);
      index(owners[0]);
    } catch {
      // owner lookup is best-effort for mentions
    }
  }

  for (const e of entries) {
    const thread = (threads || {})[e.threadId];
    const mentioned = new Set();
    for (const msg of thread.messages || []) {
      const text = String(msg.content || "");
      for (const match of text.matchAll(
        /@([a-zA-Z][a-zA-Z.\-]*(?:\s+[A-Z][a-zA-Z.\-]*)?)/g,
      )) {
        const cand = match[1].toLowerCase();
        const full = byFullName.get(cand);
        const first = byFirstName.get(cand.split(/\s+/)[0]);
        const hit = full || first;
        if (hit) mentioned.add(String(hit._id || hit.id));
      }
    }
    e.mentions = [...mentioned];
  }

  const unresolved = entries.filter((e) => !e.resolved).length;
  const resolved = entries.length - unresolved;
  const summary =
    entries.length === 0
      ? "No review comments in this project."
      : `${unresolved} unresolved comment${unresolved === 1 ? "" : "s"} remain` +
        ` (${resolved} resolved, ${entries.length} total).`;

  const assignments = await getAssignments(projectId);
  return {
    threads: entries,
    assignments,
    total: entries.length,
    unresolved,
    resolved,
    summary,
  };
}

// ---- reviewer assignment (PLANS 9: reviewer roles) ----

async function listProjectMembers(projectId) {
  const memberIds = await CollaboratorsGetter.promises.getMemberIds(projectId);
  const members = await UserGetter.promises.getUsers(memberIds, {
    email: 1,
    first_name: 1,
    last_name: 1,
  });
  return memberIds.map((id) => {
    const u = Array.isArray(members)
      ? members.find((m) => String(m._id) === String(id))
      : null;
    return {
      _id: String(id),
      email: u?.email || null,
      name:
        [u?.first_name, u?.last_name].filter(Boolean).join(" ") ||
        u?.email ||
        String(id),
    };
  });
}

async function getReviewers(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    owner_ref: 1,
    reviewers: 1,
  });
  if (project == null) throw new OError("project not found", { projectId });
  const ids = (project.reviewers || []).map(String);
  if (ids.length === 0) return [];
  const users = await UserGetter.promises.getUsers(ids, {
    email: 1,
    first_name: 1,
    last_name: 1,
  });
  return ids.map((id) => {
    const u = Array.isArray(users)
      ? users.find((m) => String(m._id) === id)
      : null;
    return {
      _id: id,
      email: u?.email || null,
      name:
        [u?.first_name, u?.last_name].filter(Boolean).join(" ") ||
        u?.email ||
        id,
    };
  });
}

/**
 * Assign a reviewer. Must be an existing project member (owner or
 * collaborator) — external accounts cannot be added here. Audited.
 */
async function addReviewer(projectId, reviewerId, userId) {
  const memberIds = await CollaboratorsGetter.promises.getMemberIds(projectId);
  const memberSet = new Set(memberIds.map(String));
  const ownerId = await getOwnerId(projectId);
  memberSet.add(String(ownerId));
  if (!memberSet.has(String(reviewerId))) {
    throw new OError("reviewer must be a project member", { reviewerId });
  }
  await Project.updateOne(
    { _id: projectId },
    { $addToSet: { reviewers: reviewerId } },
  ).exec();
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: "reviewer-assigned",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: { after: { reviewerId: String(reviewerId) } },
  });
}

async function removeReviewer(projectId, reviewerId, userId) {
  await Project.updateOne(
    { _id: projectId },
    { $pull: { reviewers: reviewerId } },
  ).exec();
  await AuditLogManager.promises.recordAudit({
    actorId: userId,
    action: "reviewer-removed",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: { reviewerId: String(reviewerId) },
  });
}

async function getOwnerId(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    owner_ref: 1,
  });
  return project?.owner_ref;
}

// ---- thread assignment (PLANS 9 "Assign comments") ----

async function assignThread(projectId, threadId, assigneeId, assignedBy) {
  const { ReviewAssignment } =
    await import("../../models/ReviewAssignment.mjs");
  await ReviewAssignment.updateOne(
    { projectId, threadId },
    { assigneeId, assignedBy },
    { upsert: true },
  );
  await AuditLogManager.promises.recordAudit({
    actorId: assignedBy,
    action: "review-comment-assigned",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: { threadId, assigneeId: String(assigneeId) },
  });
  return { threadId, assigneeId: String(assigneeId) };
}

async function unassignThread(projectId, threadId, actorId) {
  const { ReviewAssignment } =
    await import("../../models/ReviewAssignment.mjs");
  await ReviewAssignment.deleteOne({ projectId, threadId });
  await AuditLogManager.promises.recordAudit({
    actorId,
    action: "review-comment-unassigned",
    targetType: "project",
    targetId: String(projectId),
    projectId,
    info: { threadId },
  });
  return { threadId, assigneeId: null };
}

async function getAssignments(projectId) {
  const { ReviewAssignment } =
    await import("../../models/ReviewAssignment.mjs");
  const rows = await ReviewAssignment.find({ projectId }).lean();
  const map = {};
  for (const row of rows) {
    map[row.threadId] = String(row.assigneeId);
  }
  return map;
}

export default {
  getReviewStatus,
  listProjectMembers,
  getReviewers,
  addReviewer,
  removeReviewer,
  promises: {
    getReviewStatus,
    listProjectMembers,
    getReviewers,
    addReviewer,
    removeReviewer,
    assignThread,
    unassignThread,
    getAssignments,
  },
  assignThread,
  unassignThread,
  getAssignments,
};
