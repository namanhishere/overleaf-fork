import { expressify } from "@overleaf/promise-utils";
import SessionManager from "../Authentication/SessionManager.mjs";
import ReviewService from "./ReviewService.mjs";

function _userId(req) {
  return SessionManager.getLoggedInUserId(req.session);
}

// GET /project/:Project_id/review — page
async function reviewPage(req, res) {
  res.render("project/review", { projectId: req.params.Project_id });
}

// GET /project/:Project_id/api/review
async function getReviewStatus(req, res) {
  const projectId = req.params.Project_id;
  const [status, reviewers, members] = await Promise.all([
    ReviewService.promises.getReviewStatus(projectId),
    ReviewService.promises.getReviewers(projectId),
    ReviewService.promises.listProjectMembers(projectId),
  ]);
  res.json({ ...status, reviewers, members });
}

// POST /project/:Project_id/api/review/reviewers  { reviewerId }
async function addReviewer(req, res) {
  await ReviewService.promises.addReviewer(
    req.params.Project_id,
    req.body?.reviewerId,
    _userId(req),
  );
  const reviewers = await ReviewService.promises.getReviewers(
    req.params.Project_id,
  );
  res.json({ reviewers });
}

// DELETE /project/:Project_id/api/review/reviewers/:reviewerId
async function removeReviewer(req, res) {
  await ReviewService.promises.removeReviewer(
    req.params.Project_id,
    req.params.reviewerId,
    _userId(req),
  );
  const reviewers = await ReviewService.promises.getReviewers(
    req.params.Project_id,
  );
  res.json({ reviewers });
}

// POST /project/:Project_id/api/review/threads/:threadId/resolve
async function resolveThread(req, res) {
  const ChatApiHandler = (await import("../Chat/ChatApiHandler.mjs")).default;
  await ChatApiHandler.promises.resolveThread(
    req.params.Project_id,
    req.params.threadId,
    _userId(req),
  );
  res.sendStatus(204);
}

// POST /project/:Project_id/api/review/threads/:threadId/reopen
async function reopenThread(req, res) {
  const ChatApiHandler = (await import("../Chat/ChatApiHandler.mjs")).default;
  await ChatApiHandler.promises.reopenThread(
    req.params.Project_id,
    req.params.threadId,
  );
  res.sendStatus(204);
}

export default {
  reviewPage: expressify(reviewPage),
  getReviewStatus: expressify(getReviewStatus),
  addReviewer: expressify(addReviewer),
  removeReviewer: expressify(removeReviewer),
  resolveThread: expressify(resolveThread),
  reopenThread: expressify(reopenThread),
};
