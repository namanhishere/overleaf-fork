import { expressify } from "@overleaf/promise-utils";
import SessionManager from "../Authentication/SessionManager.mjs";
import SecretsService from "./SecretsService.mjs";

function _userId(req) {
  return SessionManager.getLoggedInUserId(req.session);
}

// GET /project/:Project_id/api/secrets — names and metadata only
async function listSecrets(req, res) {
  const secrets = await SecretsService.promises.listSecrets(
    req.params.Project_id,
  );
  res.json({ secrets });
}

// POST /project/:Project_id/api/secrets  { key, value }
async function setSecret(req, res) {
  try {
    const result = await SecretsService.promises.setSecret(
      req.params.Project_id,
      req.body?.key,
      req.body?.value,
      _userId(req),
    );
    res.status(201).json(result);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("invalid secret key") || msg.includes("missing secret")) {
      return res.status(400).json({ error: msg });
    }
    throw err;
  }
}

// DELETE /project/:Project_id/api/secrets/:key
async function deleteSecret(req, res) {
  try {
    await SecretsService.promises.deleteSecret(
      req.params.Project_id,
      req.params.key,
      _userId(req),
    );
    res.sendStatus(204);
  } catch (err) {
    if (String(err?.message).includes("secret not found")) {
      return res.status(404).json({ error: "secret not found" });
    }
    throw err;
  }
}

export default {
  listSecrets: expressify(listSecrets),
  setSecret: expressify(setSecret),
  deleteSecret: expressify(deleteSecret),
};
