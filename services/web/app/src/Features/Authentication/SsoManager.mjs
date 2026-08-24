import crypto from "node:crypto";
import OError from "@overleaf/o-error";
import Settings from "@overleaf/settings";
import { fetchString } from "@overleaf/fetch-utils";
import { SsoProvider } from "../../models/SsoProvider.mjs";
import UserGetter from "../User/UserGetter.mjs";
import UserCreator from "../User/UserCreator.mjs";
import ldapjs from "ldapjs";

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour
const discoveryCache = new Map(); // slug -> { doc, expiresAt }

function publicView(provider) {
  // Never leak the client secret through any API response.
  const { clientSecret, ...safe } = provider;
  return safe;
}

async function listProviders({ enabledOnly = false } = {}) {
  const query = enabledOnly ? { enabled: true } : {};
  const providers = await SsoProvider.find(query)
    .sort({ name: 1 })
    .lean()
    .exec();
  return providers.map(publicView);
}

async function getProvider(slug, { enabledOnly = false } = {}) {
  const query = enabledOnly ? { slug, enabled: true } : { slug };
  return SsoProvider.findOne(query).lean().exec();
}

async function createProvider(body, userId = null) {
  const slug = String(body.slug || "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new OError("invalid provider slug", { slug });
  }
  if (!body.name || !String(body.name).trim()) {
    throw new OError("missing provider field: name", { field: "name" });
  }
  const type = body.type === "ldap" ? "ldap" : "oidc";
  if (type === "oidc") {
    for (const field of ["issuerUrl", "clientId", "clientSecret"]) {
      if (!body[field] || !String(body[field]).trim()) {
        throw new OError(`missing provider field: ${field}`, { field });
      }
    }
  } else {
    for (const field of ["ldapUrl", "baseDn"]) {
      if (!body[field] || !String(body[field]).trim()) {
        throw new OError(`missing provider field: ${field}`, { field });
      }
    }
  }
  try {
    const provider = await SsoProvider.create({
      slug,
      name: String(body.name).trim().slice(0, 100),
      type,
      enabled: Boolean(body.enabled),
      issuerUrl:
        type === "oidc" && body.issuerUrl
          ? String(body.issuerUrl).trim().replace(/\/$/, "")
          : null,
      clientId:
        type === "oidc" && body.clientId
          ? String(body.clientId).trim()
          : null,
      clientSecret:
        type === "oidc" && body.clientSecret
          ? String(body.clientSecret)
          : null,
      ldapUrl: body.ldapUrl ? String(body.ldapUrl).trim() : null,
      adminDn: body.adminDn ? String(body.adminDn).trim() : null,
      adminPassword: body.adminPassword ? String(body.adminPassword) : null,
      baseDn: body.baseDn ? String(body.baseDn).trim() : null,
      searchFilter: String(body.searchFilter || "(mail={{username}})"),
      autoRegister: body.autoRegister !== false,
      createdBy: userId,
    });
    return publicView(provider.toObject());
  } catch (err) {
    if (err?.code === 11000) {
      throw new OError("duplicate provider slug", { slug });
    }
    throw err;
  }
}

async function updateProvider(slug, body, userId = null) {
  const before = await getProvider(slug);
  if (before == null) {
    throw new OError("provider not found", { slug });
  }
  const patch = {};
  if (body.name != null) patch.name = String(body.name).trim().slice(0, 100);
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
  if (body.issuerUrl != null)
    patch.issuerUrl = String(body.issuerUrl).trim().replace(/\/$/, "");
  if (body.clientId != null) patch.clientId = String(body.clientId).trim();
  // clientSecret is write-only: only update when a non-empty value arrives.
  if (body.clientSecret) patch.clientSecret = String(body.clientSecret);
  if (body.scopes != null) patch.scopes = String(body.scopes);
  if (body.ldapUrl != null)
    patch.ldapUrl = String(body.ldapUrl).trim() || null;
  if (body.adminDn != null) patch.adminDn = String(body.adminDn).trim() || null;
  if (body.adminPassword) patch.adminPassword = String(body.adminPassword);
  if (body.baseDn != null) patch.baseDn = String(body.baseDn).trim() || null;
  if (body.searchFilter != null)
    patch.searchFilter = String(body.searchFilter);
  if (body.autoRegister !== undefined)
    patch.autoRegister = Boolean(body.autoRegister);
  await SsoProvider.updateOne({ slug }, { $set: patch }).exec();
  await invalidateDiscovery(slug);
  return publicView(await getProvider(slug));
}

async function deleteProvider(slug) {
  const before = await getProvider(slug);
  if (before == null) {
    throw new OError("provider not found", { slug });
  }
  await SsoProvider.deleteOne({ slug }).exec();
  await invalidateDiscovery(slug);
}

/**
 * OIDC discovery document, cached per provider slug for an hour.
 */
async function getDiscovery(provider) {
  const cached = discoveryCache.get(provider.slug);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.doc;
  }
  const raw = await fetchString(
    `${provider.issuerUrl}/.well-known/openid-configuration`,
  );
  const doc = JSON.parse(raw);
  for (const field of [
    "authorization_endpoint",
    "token_endpoint",
    "userinfo_endpoint",
  ]) {
    if (!doc[field]) {
      throw new OError(`discovery document missing ${field}`, {
        issuer: provider.issuerUrl,
      });
    }
  }
  discoveryCache.set(provider.slug, {
    doc,
    expiresAt: Date.now() + DISCOVERY_TTL_MS,
  });
  return doc;
}

async function invalidateDiscovery(slug) {
  discoveryCache.delete(slug);
}

function buildRedirectUri(provider) {
  const appUrl = Settings.siteUrl || Settings.appUrl || "";
  return `${appUrl.replace(/\/$/, "")}/sso/${provider.slug}/callback`;
}

/**
 * Exchange the authorization code at the token endpoint
 * (client_secret_post) and fetch the authenticated user's claims from
 * the userinfo endpoint. Using userinfo avoids local ID-token signature
 * verification: the token exchange is client-authenticated, so the
 * userinfo response is trustworthy.
 */
async function exchangeCode(provider, discovery, code) {
  const redirectUri = buildRedirectUri(provider);
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
  });
  const tokenRaw = await fetchString(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const tokens = JSON.parse(tokenRaw);
  if (!tokens.access_token) {
    throw new OError("token endpoint returned no access_token");
  }
  const claimsRaw = await fetchString(discovery.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const claims = JSON.parse(claimsRaw);
  if (!claims.sub) {
    throw new OError("userinfo response missing sub");
  }
  return claims;
}

/**
 * Match an SSO identity to a local user by (verified) email, creating an
 * account when the provider allows auto-registration.
 */
async function findOrCreateUser(provider, claims) {
  const email = String(claims.email || "").toLowerCase();
  if (!email) {
    throw new OError("userinfo response missing email");
  }
  // Full document: the user object is stored in the session and the login
  // handlers read many fields (analytics, labs, features, ...).
  const user = await UserGetter.promises.getUser({
    $or: [{ email }, { emails: { $elemMatch: { email } } }],
  });
  if (user != null) return user;
  if (!provider.autoRegister) {
    throw new OError("no local account for SSO identity", { email });
  }
  const names = String(claims.name || "").trim().split(/\s+/);
  const firstName = claims.given_name || names[0] || email.split("@")[0];
  const lastName = claims.family_name || names.slice(1).join(" ") || "";
  return UserCreator.promises.createNewUser({
    email,
    first_name: firstName,
    last_name: lastName,
    holdingAccount: false,
    analyticsId: crypto.randomBytes(16).toString("hex"),
  });
}

/**
 * Authenticate a username/password against an LDAP provider: service bind
 * (when adminDn is configured), user lookup via searchFilter, then a bind
 * as the found user DN to verify the password. Returns the identity
 * { email, name } or null when the credentials are rejected.
 */
async function authenticateLdap(provider, username, password) {
  if (provider.type !== "ldap" || !provider.ldapUrl) {
    throw new OError("not an LDAP provider", { slug: provider.slug });
  }
  const escapeLdap = (v) =>
    String(v).replace(/[\\*()\0]/g, (c) => "\\" + c.charCodeAt(0).toString(16).padStart(2, "0"));
  const filter = (provider.searchFilter || "(mail={{username}})").replace(
    "{{username}}",
    escapeLdap(username),
  );

  const client = ldapjs.createClient({ url: provider.ldapUrl });
  const bindAs = (dn, pw) =>
    new Promise((resolve, reject) =>
      client.bind(dn, pw, (err) => (err ? reject(err) : resolve())),
    );
  const search = (base, opts) =>
    new Promise((resolve, reject) => {
      client.search(base, opts, (err, res) => {
        if (err) return reject(err);
        const entries = [];
        res.on("searchEntry", (entry) => entries.push(entry));
        res.on("error", reject);
        res.on("end", () => resolve(entries));
      });
    });

  try {
    if (provider.adminDn) {
      await bindAs(provider.adminDn, provider.adminPassword || "");
    }
    const entries = await search(provider.baseDn, {
      scope: "sub",
      filter,
      sizeLimit: 2,
    });
    if (entries.length !== 1) {
      return null; // unknown user or ambiguous match: treat as rejection
    }
    const entry = entries[0];
    const dn = entry.object ? entry.object.dn : entry.dn;
    await bindAs(dn, password); // rejects when the password is wrong
    const attrs = entry.object || {};
    const emailAttr =
      attrs.mail ||
      attrs.email ||
      (Array.isArray(attrs.mail) ? attrs.mail[0] : null);
    return {
      email: String(emailAttr || username).toLowerCase(),
      name: String(attrs.cn || attrs.name || username),
    };
  } catch (err) {
    // Invalid-credentials style errors mean rejection, not failure.
    const msg = String(err?.message || err);
    if (
      err?.name === "InvalidCredentialsError" ||
      /invalid credentials/i.test(msg) ||
      /no such object/i.test(msg)
    ) {
      return null;
    }
    throw new OError("ldap authentication error", { slug: provider.slug }, err);
  } finally {
    try {
      client.unbind(() => {});
    } catch {
      // ignore unbind errors
    }
  }
}

function generateState() {
  return crypto.randomBytes(24).toString("hex");
}

const SsoManager = {
  authenticateLdap,
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
  getDiscovery,
  invalidateDiscovery,
  buildRedirectUri,
  exchangeCode,
  findOrCreateUser,
  generateState,
  promises: {
    authenticateLdap,
    listProviders,
    getProvider,
    createProvider,
    updateProvider,
    deleteProvider,
    getDiscovery,
    invalidateDiscovery,
    buildRedirectUri,
    exchangeCode,
    findOrCreateUser,
    generateState,
  },
};

export default SsoManager;
