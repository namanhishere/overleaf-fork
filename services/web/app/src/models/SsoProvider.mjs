import mongoose from "../infrastructure/Mongoose.mjs";

const { Schema } = mongoose

// Externally configured OIDC/OAuth2 identity provider. Providers are
// database-backed so new identity providers can be added at runtime
// without a deploy; each provider is enabled/disabled independently.
const SsoProviderSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    enabled: { type: Boolean, default: false },
    // OIDC issuer base url; discovery document is read from
    // {issuerUrl}/.well-known/openid-configuration
    issuerUrl: { type: String, required: true },
    clientId: { type: String, required: true },
    // Stored write-only: never returned by any API response.
    clientSecret: { type: String, required: true },
    scopes: { type: String, default: "openid email profile" },
    // Create a local account on first SSO login when no user matches.
    autoRegister: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, default: null },
  },
  { collection: "ssoProviders", timestamps: true },
)

export const SsoProvider = mongoose.model(
  'SsoProvider',
  SsoProviderSchema
)
