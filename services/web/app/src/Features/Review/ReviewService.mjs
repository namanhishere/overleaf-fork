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

  const unresolved = entries.filter((e) => !e.resolved).length;
  const resolved = entries.length - unresolved;
  const summary =
    entries.length === 0
      ? "No review comments in this project."
      : `${unresolved} unresolved comment${unresolved === 1 ? "" : "s"} remain` +
        ` (${resolved} resolved, ${entries.length} total).`;

  return {
    threads: entries,
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
  },
};
