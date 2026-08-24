import mongoose from "../infrastructure/Mongoose.mjs";

const { Schema } = mongoose;

// Externally configured OIDC/OAuth2 identity provider. Providers are
// database-backed so new identity providers can be added at runtime
// without a deploy; each provider is enabled/disabled independently.
const SsoProviderSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    // 'oidc': redirect-based OpenID Connect; 'ldap': direct bind against
    // a directory server from the login form.
    type: { type: String, enum: ["oidc", "ldap"], default: "oidc" },
    enabled: { type: Boolean, default: false },
    // --- OIDC fields ---
    // OIDC issuer base url; discovery document is read from
    // {issuerUrl}/.well-known/openid-configuration
    issuerUrl: { type: String, default: null },
    clientId: { type: String, default: null },
    // Stored write-only: never returned by any API response.
    clientSecret: { type: String, default: null },
    scopes: { type: String, default: "openid email profile" },
    // --- LDAP fields ---
    ldapUrl: { type: String, default: null },
    // Service bind credentials for the user search (optional when the
    // directory allows anonymous search).
    adminDn: { type: String, default: null },
    adminPassword: { type: String, default: null },
    baseDn: { type: String, default: null },
    // {{username}} is replaced with the submitted login email.
    searchFilter: { type: String, default: "(mail={{username}})" },
    // --- shared ---
  },
  { collection: "ssoProviders", timestamps: true },
);

export const SsoProvider = mongoose.model("SsoProvider", SsoProviderSchema);
