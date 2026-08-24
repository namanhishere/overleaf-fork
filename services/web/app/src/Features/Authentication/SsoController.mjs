import { expressify } from "@overleaf/promise-utils";
import Settings from "@overleaf/settings";
import logger from "@overleaf/logger";
import SsoManager from "./SsoManager.mjs";
import SessionManager from "./SessionManager.mjs";
import AuditLogManager from "../Audit/AuditLogManager.mjs";
import UserAuditLogHandler from "../User/UserAuditLogHandler.mjs";
import UserUpdater from "../User/UserUpdater.mjs";

function _userId(req) {
  return SessionManager.getLoggedInUserId(req.session);
}

// POST /login middleware: when the submitted credentials match an
// enabled LDAP provider, complete the login here and skip the local
// password check. Otherwise fall through to local authentication.
async function tryLdapLogin(req, res, next) {
  const email = String(req.body?.email || "").trim();
  const password = String(req.body?.password || "");
  if (!email || !password) return next();

  let providers = [];
  try {
    providers = (
      await SsoManager.promises.listProviders({ enabledOnly: true })
    ).filter((p) => p.type === "ldap");
  } catch {
    return next();
  }
  if (providers.length === 0) return next();

  for (const provider of providers) {
    let identity = null;
    try {
      identity = await SsoManager.promises.authenticateLdap(
        provider,
        email,
        password,
      );
    } catch (err) {
      logger.warn({ err, slug: provider.slug }, "ldap login: directory error");
      continue;
    }
    if (identity == null) continue;

    try {
      const user = await SsoManager.promises.findOrCreateUser(provider, {
        sub: identity.email,
        email: identity.email,
        name: identity.name,
      });
      const userId = String(user._id);

      await UserUpdater.promises.updateUser(userId, {
        $set: { lastLoggedIn: new Date() },
        $inc: { loginCount: 1 },
      });
      await UserAuditLogHandler.promises.addEntry(
        userId,
        "login",
        userId,
        req.ip,
        { method: `LDAP login (${provider.slug})` },
      );

      await new Promise((resolve, reject) =>
        req.session.regenerate((err) => (err ? reject(err) : resolve())),
      );
      req.session.passport = {
        user: {
          _id: user._id,
          first_name: user.first_name,
          last_name: user.last_name,
          email: user.email,
          session_created: new Date().toISOString(),
          ip_address: req.ip,
          analyticsId: user.analyticsId || String(user._id),
          ...(user.isAdmin ? { isAdmin: true } : {}),
        },
      };
      req.session.analyticsId = user.analyticsId || String(user._id);
      await new Promise((resolve, reject) =>
        req.session.save((err) => (err ? reject(err) : resolve())),
      );

      await AuditLogManager.promises.recordAudit({
        actorId: userId,
        action: "login",
        targetType: "user",
        targetId: userId,
        info: { method: `LDAP login (${provider.slug})` },
        ipAddress: req.ip,
      });

      return res.redirect("/project");
    } catch (err) {
      logger.warn({ err, slug: provider.slug }, "ldap login: failed");
      return next();
    }
  }
  return next();
}

// GET /sso/:slug/start
async function start(req, res) {
  const provider = await SsoManager.promises.getProvider(req.params.slug, {
    enabledOnly: true,
  });
  if (provider == null) {
    return res.status(404).json({ error: "unknown SSO provider" });
  }
  const discovery = await SsoManager.promises.getDiscovery(provider);
  const state = SsoManager.promises.generateState();
  req.session.sso = {
    slug: provider.slug,
    state,
    createdAt: Date.now(),
  };
  const params = new URLSearchParams({
    response_type: "code",
    client_id: provider.clientId,
    redirect_uri: SsoManager.promises.buildRedirectUri(provider),
    scope: provider.scopes || "openid email profile",
    state,
  });
  res.redirect(`${discovery.authorization_endpoint}?${params}`);
}

// GET /sso/:slug/callback
//
// Establishes the session with a single, deliberate session-id rotation
// (fixation-safe). We deliberately do not route through passport's
// req.login here: passport 0.6 regenerates on every login and
// _afterLoginSessionSetup regenerates again, and the custom session store
// only tracks one pending rotation per request.
async function callback(req, res) {
  const ssoSession = req.session.sso;
  const provider = await SsoManager.promises.getProvider(req.params.slug, {
    enabledOnly: true,
  });
  if (
    provider == null ||
    ssoSession == null ||
    ssoSession.slug !== provider.slug
  ) {
    delete req.session.sso;
    logger.warn({ slug: req.params.slug }, "sso callback: bad session");
    return res.redirect("/login");
  }
  if (
    !req.query.code ||
    !req.query.state ||
    req.query.state !== ssoSession.state
  ) {
    delete req.session.sso;
    logger.warn({ slug: req.params.slug }, "sso callback: state mismatch");
    return res.redirect("/login");
  }
  if (Date.now() - ssoSession.createdAt > 10 * 60 * 1000) {
    delete req.session.sso;
    logger.warn({ slug: req.params.slug }, "sso callback: expired");
    return res.redirect("/login");
  }
  delete req.session.sso;

  try {
    const discovery = await SsoManager.promises.getDiscovery(provider);
    const claims = await SsoManager.promises.exchangeCode(
      provider,
      discovery,
      String(req.query.code),
    );
    const user = await SsoManager.promises.findOrCreateUser(provider, claims);
    const userId = String(user._id);

    // Same bookkeeping the password login performs.
    await UserUpdater.promises.updateUser(userId, {
      $set: { lastLoggedIn: new Date() },
      $inc: { loginCount: 1 },
    });
    await UserAuditLogHandler.promises.addEntry(
      userId,
      "login",
      userId,
      req.ip,
      { method: `SSO login (${provider.slug})` },
    );

    // Single session-id rotation, then establish the session directly.
    // The stored shape must mirror AuthenticationController.serializeUser's
    // light user (SessionManager reads session.passport.user._id).
    await new Promise((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.passport = {
      user: {
        _id: user._id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        session_created: new Date().toISOString(),
        ip_address: req.ip,
        analyticsId: user.analyticsId || String(user._id),
        ...(user.isAdmin ? { isAdmin: true } : {}),
      },
    };
    req.session.analyticsId = user.analyticsId || String(user._id);
    await new Promise((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );

    await AuditLogManager.promises.recordAudit({
      actorId: userId,
      action: "login",
      targetType: "user",
      targetId: userId,
      info: { method: `SSO login (${provider.slug})` },
      ipAddress: req.ip,
    });

    res.redirect("/project");
  } catch (err) {
    // Failed SSO logins bounce back to the login page; details are logged.
    logger.warn({ err, slug: req.params.slug }, "sso callback: login failed");
    res.redirect("/login");
  }
}

// ---- Admin management ----

// GET /admin/api/sso
async function listProviders(req, res) {
  const providers = await SsoManager.promises.listProviders();
  res.json({ providers });
}

// POST /admin/api/sso
async function createProvider(req, res) {
  try {
    const provider = await SsoManager.promises.createProvider(
      req.body || {},
      _userId(req),
    );
    await AuditLogManager.promises.recordAudit({
      actorId: _userId(req),
      action: "sso-provider-created",
      targetType: "sso-provider",
      targetId: provider.slug,
      info: { after: { ...provider, clientSecret: undefined } },
    });
    res.status(201).json({ provider });
  } catch (err) {
    const msg = String(err?.message || err);
    if (
      msg.includes("invalid provider slug") ||
      msg.includes("duplicate") ||
      msg.startsWith("missing provider field")
    ) {
      return res.status(400).json({ error: msg });
    }
    throw err;
  }
}

// PATCH /admin/api/sso/:slug
async function updateProvider(req, res) {
  try {
    const provider = await SsoManager.promises.updateProvider(
      req.params.slug,
      req.body || {},
      _userId(req),
    );
    await AuditLogManager.promises.recordAudit({
      actorId: _userId(req),
      action: "sso-provider-updated",
      targetType: "sso-provider",
      targetId: req.params.slug,
      info: { after: { ...provider, clientSecret: undefined } },
    });
    res.json({ provider });
  } catch (err) {
    if (String(err?.message).includes("provider not found")) {
      return res.status(404).json({ error: "provider not found" });
    }
    throw err;
  }
}

// DELETE /admin/api/sso/:slug
async function deleteProvider(req, res) {
  try {
    await SsoManager.promises.deleteProvider(req.params.slug);
    await AuditLogManager.promises.recordAudit({
      actorId: _userId(req),
      action: "sso-provider-deleted",
      targetType: "sso-provider",
      targetId: req.params.slug,
    });
    res.sendStatus(204);
  } catch (err) {
    if (String(err?.message).includes("provider not found")) {
      return res.status(404).json({ error: "provider not found" });
    }
    throw err;
  }
}

export default {
  tryLdapLogin,
  start: expressify(start),
  callback: expressify(callback),
  listProviders: expressify(listProviders),
  createProvider: expressify(createProvider),
  updateProvider: expressify(updateProvider),
  deleteProvider: expressify(deleteProvider),
};
