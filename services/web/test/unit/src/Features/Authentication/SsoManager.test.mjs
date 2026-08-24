import { vi, expect, describe, beforeEach, afterEach, it } from "vitest";
import sinon from "sinon";
import path from "node:path";

const modulePath = path.join(
  import.meta.dirname,
  "../../../../../app/src/Features/Authentication/SsoManager.mjs",
);

const DISCOVERY = {
  authorization_endpoint: "https://idp.example.com/authorize",
  token_endpoint: "https://idp.example.com/token",
  userinfo_endpoint: "https://idp.example.com/userinfo",
};

const PROVIDER = {
  slug: "university",
  name: "University SSO",
  enabled: true,
  issuerUrl: "https://idp.example.com",
  clientId: "client-123",
  clientSecret: "secret-abc",
  scopes: "openid email profile",
  autoRegister: true,
};

describe("SsoManager", function () {
  beforeEach(async function (ctx) {
    ctx.SsoProvider = {
      create: sinon.stub().callsFake(async doc => ({
        toObject: () => doc,
        ...doc,
      })),
      find: sinon.stub().returns({
        sort: sinon.stub().returnsThis(),
        lean: sinon.stub().returnsThis(),
        exec: sinon.stub().resolves([]),
      }),
      findOne: sinon.stub().returns({
        lean: sinon.stub().resolves(null),
      }),
      updateOne: sinon.stub().returns({ exec: sinon.stub().resolves({}) }),
      deleteOne: sinon.stub().returns({ exec: sinon.stub().resolves({}) }),
    };
    ctx.UserGetter = {
      promises: { getUser: sinon.stub().resolves(null) },
    };
    ctx.UserCreator = {
      promises: {
        createNewUser: sinon
          .stub()
          .callsFake(async attrs => ({ _id: "new-user", ...attrs })),
      },
    };
    ctx.fetchString = sinon.stub();

    vi.doMock("../../../../../app/src/models/SsoProvider.mjs", () => ({
      SsoProvider: ctx.SsoProvider,
    }));
    vi.doMock("../../../../../app/src/Features/User/UserGetter.mjs", () => ({
      default: ctx.UserGetter,
      UserGetter: ctx.UserGetter,
    }));
    vi.doMock("../../../../../app/src/Features/User/UserCreator.mjs", () => ({
      default: ctx.UserCreator,
      UserCreator: ctx.UserCreator,
    }));
    vi.doMock("@overleaf/fetch-utils", () => ({
      fetchString: ctx.fetchString,
    }));
    vi.doMock("@overleaf/settings", () => ({
      default: { siteUrl: "http://localhost:3000" },
    }));

    ctx.manager = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.resetModules();
  });

  describe("createProvider", function () {
    it("creates a provider and hides the secret from the view", async function (ctx) {
      const provider = await ctx.manager.promises.createProvider(PROVIDER);
      expect(provider.slug).to.equal("university");
      expect(provider.clientSecret).to.be.undefined;
    });

    it("rejects invalid slugs and missing fields", async function (ctx) {
      await expect(
        ctx.manager.promises.createProvider({ ...PROVIDER, slug: "Bad!" }),
      ).to.be.rejectedWith(/invalid provider slug/);
      await expect(
        ctx.manager.promises.createProvider({ ...PROVIDER, clientSecret: "" }),
      ).to.be.rejectedWith(/missing provider field/);
    });
  });

  describe("getDiscovery", function () {
    it("fetches and caches the discovery document", async function (ctx) {
      // the discovery cache is module-global; start from a clean slate
      ctx.manager.promises.invalidateDiscovery("university");
      ctx.fetchString.resolves(JSON.stringify(DISCOVERY));
      const provider = { slug: "university", issuerUrl: PROVIDER.issuerUrl };
      const doc1 = await ctx.manager.promises.getDiscovery(provider);
      const doc2 = await ctx.manager.promises.getDiscovery(provider);
      expect(doc1.authorization_endpoint).to.equal(DISCOVERY.authorization_endpoint);
      expect(doc2).to.deep.equal(doc1);
      expect(ctx.fetchString.calledOnce).to.be.true;
      ctx.manager.promises.invalidateDiscovery(provider.slug);
      await ctx.manager.promises.getDiscovery(provider);
      expect(ctx.fetchString.calledTwice).to.be.true;
    });

    it("rejects incomplete discovery documents", async function (ctx) {
      ctx.manager.promises.invalidateDiscovery("university");
      ctx.fetchString.resolves(JSON.stringify({ authorization_endpoint: "x" }));
      await expect(
        ctx.manager.promises.getDiscovery({
          slug: "university",
          issuerUrl: PROVIDER.issuerUrl,
        }),
      ).to.be.rejectedWith(/missing token_endpoint/);
    });
  });

  describe("exchangeCode", function () {
    it("posts to the token endpoint and reads userinfo", async function (ctx) {
      ctx.fetchString.onFirstCall().resolves(JSON.stringify({ access_token: "at" }));
      ctx.fetchString.onSecondCall().resolves(
        JSON.stringify({ sub: "user-1", email: "alice@university.edu" }),
      );
      const claims = await ctx.manager.promises.exchangeCode(
        PROVIDER,
        DISCOVERY,
        "auth-code",
      );
      expect(claims.email).to.equal("alice@university.edu");
      const [tokenUrl, tokenOpts] = ctx.fetchString.firstCall.args;
      expect(tokenUrl).to.equal(DISCOVERY.token_endpoint);
      expect(tokenOpts.body).to.contain("grant_type=authorization_code");
      expect(tokenOpts.body).to.contain("client_secret=secret-abc");
      const [infoUrl, infoOpts] = ctx.fetchString.secondCall.args;
      expect(infoUrl).to.equal(DISCOVERY.userinfo_endpoint);
      expect(infoOpts.headers.Authorization).to.equal("Bearer at");
    });

    it("rejects token responses without access_token", async function (ctx) {
      ctx.fetchString.resolves(JSON.stringify({ error: "bad" }));
      await expect(
        ctx.manager.promises.exchangeCode(PROVIDER, DISCOVERY, "code"),
      ).to.be.rejectedWith(/no access_token/);
    });
  });

  describe("findOrCreateUser", function () {
    it("matches an existing user by verified email", async function (ctx) {
      ctx.UserGetter.promises.getUser.resolves({ _id: "u1", email: "alice@university.edu" });
      const user = await ctx.manager.promises.findOrCreateUser(PROVIDER, {
        sub: "s1",
        email: "alice@university.edu",
      });
      expect(user._id).to.equal("u1");
      expect(ctx.UserCreator.promises.createNewUser.called).to.be.false;
    });

    it("auto-registers a new user when allowed", async function (ctx) {
      ctx.UserGetter.promises.getUser.resolves(null);
      const user = await ctx.manager.promises.findOrCreateUser(PROVIDER, {
        sub: "s2",
        email: "bob@university.edu",
        name: "Bob Q Smith",
      });
      expect(user.email).to.equal("bob@university.edu");
      expect(user.first_name).to.equal("Bob");
      expect(user.last_name).to.equal("Q Smith");
    });

    it("refuses unknown users when autoRegister is off", async function (ctx) {
      ctx.UserGetter.promises.getUser.resolves(null);
      await expect(
        ctx.manager.promises.findOrCreateUser(
          { ...PROVIDER, autoRegister: false },
          { sub: "s3", email: "carol@university.edu" },
        ),
      ).to.be.rejectedWith(/no local account/);
    });

    it("requires an email claim", async function (ctx) {
      await expect(
        ctx.manager.promises.findOrCreateUser(PROVIDER, { sub: "s4" }),
      ).to.be.rejectedWith(/missing email/);
    });
  });

  describe("buildRedirectUri", function () {
    it("uses siteUrl and the provider slug", function (ctx) {
      expect(
        ctx.manager.promises.buildRedirectUri({ slug: "university" }),
      ).to.equal("http://localhost:3000/sso/university/callback");
    });
  });
});
