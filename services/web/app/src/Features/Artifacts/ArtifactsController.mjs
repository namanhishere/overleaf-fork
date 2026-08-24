import { expressify } from "@overleaf/promise-utils";
import SessionManager from "../Authentication/SessionManager.mjs";
import ArtifactsService from "./ArtifactsService.mjs";
import ProjectUploadController from "../Uploads/ProjectUploadController.mjs";

// GET /project/:Project_id/api/artifacts
async function listArtifacts(req, res) {
  const result = await ArtifactsService.promises.listArtifacts(
    req.params.Project_id,
  );
  res.json(result);
}

// POST /project/:Project_id/api/artifacts/upload — multipart upload into
// the artifacts folder (created on demand). Delegates the actual storage
// to the standard project upload pipeline.
const multerMiddleware = ProjectUploadController.multerMiddleware;

async function uploadArtifact(req, res, next) {
  try {
    const userId = SessionManager.getLoggedInUserId(req.session);
    const folderId = await ArtifactsService.promises.ensureArtifactsFolder(
      req.params.Project_id,
      userId,
    );
    req.query.folder_id = folderId;
  } catch (err) {
    return next(err);
  }
  ProjectUploadController.uploadFile(req, res, next);
}

export default {
  listArtifacts: expressify(listArtifacts),
  upload: [multerMiddleware, expressify(uploadArtifact)],
};
