import { fetchString } from "@overleaf/fetch-utils";
import { expressify } from "@overleaf/promise-utils";
import Settings from "@overleaf/settings";
import { replicaSetStatus } from "../../infrastructure/mongodb.mjs";

const HEALTH_TIMEOUT_MS = 3000;

/**
 * Mongo replica-set health from replSetGetStatus. Standalone servers
 * (no replication) are reported as such rather than as an error, since
 * single-node dev deployments are a supported configuration.
 */
async function mongoHealth() {
  try {
    const status = await replicaSetStatus();
    const members = (status.members || []).map((m) => ({
      name: m.name,
      state: m.stateStr,
      healthy:
        m.health === 1 &&
        (m.stateStr === "PRIMARY" || m.stateStr === "SECONDARY"),
    }));
    return {
      replicaSet: true,
      setName: status.set || null,
      healthy: members.some((m) => m.state === "PRIMARY"),
      members,
    };
  } catch (err) {
    const msg = String(err?.message || err);
    if (
      msg.includes("not running with --replSet") ||
      msg.includes("no replset")
    ) {
      return {
        replicaSet: false,
        healthy: true,
        members: [],
        standalone: true,
      };
    }
    return { replicaSet: null, healthy: false, error: msg.slice(0, 200) };
  }
}

async function serviceHealth(name, url) {
  if (!url) return { name, configured: false, healthy: null };
  // Some service base urls include a path prefix (e.g. history-v1 "/api");
  // health checks always live at the service root.
  const rootUrl = url.replace(/\/api\/?$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    await fetchString(`${rootUrl}/health_check`, {
      signal: controller.signal,
    });
    return { name, url, configured: true, healthy: true };
  } catch (err) {
    return {
      name,
      url,
      configured: true,
      healthy: false,
      error: String(err?.message || err).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

// GET /admin/api/storage
async function getStorageHealth(req, res) {
  const services = await Promise.all([
    serviceHealth("filestore", Settings.apis?.filestore?.url),
    serviceHealth("history-v1", Settings.apis?.v1_history?.url),
    serviceHealth("docstore", Settings.apis?.docstore?.url),
  ]);
  const mongo = await mongoHealth();
  res.json({
    mongo,
    services,
    checkedAt: new Date().toISOString(),
  });
}

export default {
  getStorageHealth: expressify(getStorageHealth),
};
