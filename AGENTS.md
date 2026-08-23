# Repository Guidelines

## Project Overview

Overleaf Community Edition — open-source, real-time collaborative LaTeX editor (`README.md`). Yarn 4 (Berry) workspaces monorepo of Node.js microservices plus shared libraries. This fork ships a subset of upstream workspaces:

- **`services/`** — web front end + 10 backend services run in production (canonical list: `server-ce/services.js`)
- **`libraries/`** — shared `@overleaf/*` packages (logger, metrics, settings, o-error, …)
- **`server-ce/`** — packaging for the single-container CE Docker image
- **`develop/`** — docker-compose dev environment; **`tools/migrations/`** — MongoDB migrations

License: AGPLv3. Contributions require signing the CLA (checkbox in `.github/PULL_REQUEST_TEMPLATE.md`).

## Architecture & Data Flow

All services are independent HTTP (Express) or socket.io processes sharing Mongo + Redis; they talk over `Settings.apis.<service>.url` with basic auth (`WEB_API_USER`/`WEB_API_PASSWORD`). Ports: web 3000, document-updater 3003, filestore 3009, chat 3010, clsi 3013, docstore 3016, real-time 3026, notifications 3042, project-history 3054, history-v1 3100.

- **web** (`services/web`) — Express front end. Entry `app.mjs` imports metrics first, then `infrastructure/Server.mjs` which builds three routers: `webRouter`, `privateApiRouter` (`/internal/*`, basic-auth), `publicApiRouter`. Central route table `app/src/router.mjs`; per-domain code in `app/src/Features/<Name>/{<Name>Controller,<Name>Manager}.mjs`; Mongoose models in `app/src/models/*.mjs`; feature flags via `Features.mjs`; module system in `modules/` loaded by `Modules.mjs`.
- **real-time** — socket.io layer for editor collaboration; authorizes via web's `/project/:id/join` internal API.
- **document-updater** — applies operational-transform updates from Redis queues, flushes documents back to Mongo through web's internal API.
- **clsi** — runs LaTeX compiles on disk (optionally sandboxed in Docker sibling containers).
- **docstore** / **filestore** — CRUD for text docs (Mongo) and binary files (S3 via `@overleaf/object-persistor`).
- **project-history / history-v1** — compress per-doc updates into browseable full-project history.
- **chat / notifications** — simple Mongo-backed APIs.

Edit flow: browser → socket.io → **real-time** → Redis list `PendingUpdates:{docId}` + `pending-updates-list` → **document-updater** (OT apply) → publishes result to Redis pubsub `applied-ops:{docId}` → real-time broadcasts to sockets → document-updater flushes lines via web internal API → **docstore** → Mongo. Compile flow: browser → web `POST /project/:id/compile` (`CompileManager` → `ClsiManager._postToClsi`) → **clsi** compiles and returns output URLs; web streams the PDF back.

## Key Directories

| Path | Purpose |
|---|---|
| `services/web/app/src/` | web backend: `Features/` (controllers/managers per domain), `models/`, `infrastructure/`, `router.mjs` |
| `services/web/frontend/js/` | React/TypeScript front end (`features/`, `pages/`, `shared/`, `ide/`); `public/` is gitignored build output |
| `services/web/modules/<name>/` | web plugins: `{app/src,frontend/js,test}/`; existing: full-project-search, history-v1, launchpad, server-ce-scripts, user-activate |
| `services/<svc>/app.js`, `app/js/` | microservice entry + code (flat layout: `HttpController.js`, `<Domain>Manager.js`) |
| `services/<svc>/config/settings.defaults.(cjs\|js)` | per-service config, read via `@overleaf/settings` |
| `libraries/<pkg>/` | shared `@overleaf/*` packages used by all services |
| `tools/migrations/` | East-based Mongo migrations (`YYYYMMDDHHMMSS_name.mjs`) |
| `server-ce/` | Dockerfiles, `Makefile` (`build-base`, `build-community`), `runit/`, `nginx/`, `init_scripts/`, `hotfix/` |
| `develop/bin/` | dev-env scripts: `build`, `up`, `dev`, `shell`, `logs`, `down` |

## Development Commands

```sh
yarn install                          # from repo root; single hoisted node_modules (run once)

# Dev environment (docker compose; web on http://localhost/launchpad after bin/up)
cd develop && bin/build && bin/up     # build & start stack (mongo replica set + redis + services)
bin/dev [services...]                 # overlay docker-compose.dev.yml: node --watch + --inspect, webpack dev server on :3808
bin/shell <service>                   # bash inside a running container
bin/logs                              # follow logs (bunyan-filtered)

# Web frontend build
cd services/web && yarn webpack       # dev; yarn run webpack:production for prod bundle

# Quality gates (repo root)
yarn lint                             # eslint flat config, --max-warnings 0
yarn format                           # prettier --check (format:fix to write)
```

Test commands are per-package — see Testing & QA.

## Code Conventions & Common Patterns

- **Modules**: backend converging on ESM. web is `.mjs` (`import`/`export`); most microservices have `"type": "module"` with `.js`; `document-updater` and many `libraries/*` are still CommonJS (`.cjs`). Frontend: TypeScript compiled by babel + webpack.
- **Async**: async/await. Controllers are private `async _thing(req, res)` functions exported wrapped in `expressify(...)` at file bottom so rejections become 500s (e.g. `app/src/Features/Compile/CompileController.mjs`). Legacy callback APIs stay available via `callbackifyAll(X)` / a `.promises.` namespace (`ProjectGetter.mjs`, `DocstoreManager.mjs`).
- **Errors**: use `OError` from `@overleaf/o-error`: construct with info `new OError('message', { docId })`, wrap-and-rethrow `throw OError.tag(err, 'context', { userId })`. Central handlers: web `ErrorController.handleError`, microservices use `handleValidationError` from `@overleaf/validation-tools`.
- **web feature pattern**: `Features/<Name>/<Name>Controller.mjs` (express glue) + `<Name>Manager.mjs` (business logic) + optional `<Name>Router.mjs` exporting `apply(webRouter, privateApiRouter)`; routes registered in central `router.mjs` with middleware chain `rateLimit → AsyncLocalStorage.middleware → AuthorizationMiddleware → controller`.
- **Rate limiting**: declare `new RateLimiter('name', { points, duration })` next to the route; enforce via `RateLimiterMiddleware.rateLimit(rateLimiters.name)`.
- **Service entry boilerplate** (copy from any service): first import must be `import '@overleaf/metrics/initialize.js'`; then `logger.initialize('<name>')`; `/status` + `/health_check` endpoints; listen guarded by `if (import.meta.main)`.
- **Config**: never read env vars ad hoc in services — go through `Settings` (`@overleaf/settings`), which loads `<cwd>/config/settings.defaults.*` then `$OVERLEAF_CONFIG` or `settings.<NODE_ENV>.*`. Deployment env prefix is `OVERLEAF_*`; internal service wiring keeps legacy names (`CHAT_HOST`, `DOCUPDATER_HOST`, …).
- **Naming**: Mongoose models singular PascalCase in `models/<Name>.mjs`; test files `<Thing>Tests.js` (mocha) or `<Thing>.test.mjs` (vitest).

## Important Files

| File | Role |
|---|---|
| `package.json` (root) | workspaces, resolutions pins, `lint`/`format` scripts; no root test script |
| `services/web/app.mjs` | web entry: metrics init → mongo wait → listen on 3000 |
| `services/web/app/src/infrastructure/Server.mjs` | router construction/mounting, error handler |
| `services/web/app/src/router.mjs` | central route table (~1300 lines) |
| `services/web/config/settings.defaults.js` | web settings incl. `apis` block wiring all services |
| `libraries/settings/Settings.js` | shared config loader used by every service |
| `server-ce/services.js` | canonical list of production services |
| `docker-compose.yml` (root) | end-user single-container deployment (sharelatex + mongo + redis) |
| `develop/docker-compose.yml` + `dev.env` | dev stack definitions and env (`MONGO_URL`, `REDIS_HOST`, …) |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR format: Description, Related issues, CLA checkbox |

## Runtime/Tooling Preferences

- **Package manager: Yarn 4 via corepack** (`packageManager: yarn@4.14.1`). Never use npm; no `rec:*` scripts exist in CE. `yarn install` once at the root.
- **Node >= 20.19.0** (root `engines`); service Dockerfiles use node 24. `notifications` runs TypeScript directly (`node app.ts`); everything else is plain JS at runtime.
- **TypeScript is check-only on the backend**: root `tsconfig.backend.json` (`noEmit`, maps `@overleaf/*` → `libraries/*`), web script `yarn type-check:backend`; frontend has its own strict `tsconfig.json` (aliases `@/*`, `@modules/*`).
- 19 dependency patches live in `.yarn/patches/` wired through `resolutions` — don't fight them by bumping patched packages.
- No git hooks, no husky; CI is Google Cloud Build (`server-ce/cloudbuild.public.yaml`), not GitHub Actions.

## Testing & QA

No root test runner — run tests inside the package:

```sh
# web (vitest for backend units; *.test.mjs under test/unit/src)
cd services/web && yarn test:unit            # vitest run (Parallel + Sequential projects)
yarn test:unit:run_dir -- test/unit/src/Features/Compile  # one dir, MOCHA_GREP filter honored
yarn test:frontend                           # mocha + jsdom over frontend/js
yarn test:acceptance:app                     # mocha; needs docker compose dependency stack

# migrated microservices: vitest unit + mocha acceptance
cd services/clsi && yarn test:unit && yarn test:acceptance

# legacy-mocha microservices (document-updater, chat, history-v1)
cd services/document-updater && yarn test:unit

# libraries
cd libraries/o-error && yarn test:unit       # mocha; validation-tools uses vitest

# Docker route (CI parity), from any service dir:
make test_unit        # or: make test_acceptance / make test (= format+lint+types+tests)

# CE end-to-end suite (Cypress)
cd server-ce/test && make test-e2e    # interactive: make test-e2e-open
```

- **Stack**: vitest 4.1.5 (pinned) and mocha 11 + chai 4 (+ sinon-chai/chai-as-promised); sinon for stubs; `sandboxed-module` only in document-updater, `esmock` in project-history. Cypress 15 for component (`yarn cypress:run-ct`) and e2e tests.
- **Layout**: vitest units mirror source (`web`: `test/unit/src/**/*.test.mjs`; others: `test/unit/js/**/*.test.{js,ts}`); acceptance in `test/acceptance/{js,src}` with per-service `docker-compose.yml` providing mongo (replica set) + redis containers.
- **Conventions**: setups globally stub `@overleaf/logger` (and Metrics); no mongodb-memory-server — acceptance uses real containers; sequential-only web tests must be named `*.sequential.test.mjs`; grep filter env var is `MOCHA_GREP` even under vitest.
- **Coverage**: frontend `yarn test:frontend:coverage` (c8); backend via `COVERAGE_UNIT_TESTS=true` / `COVERAGE_ACCEPTANCE_TESTS=true`.
- **Types/lint extras**: `yarn types:check` per package; styles via `yarn lint:styles` (web); shellcheck via service Makefiles.

## Gotchas

- `git-bridge` is Java/Maven, not Node.
- Service `Dockerfile`s and `Makefile`s carry "auto-generated, do not edit" headers; the upstream generator isn't in this fork — treat structural changes there as upstream-sync territory.
- Mongo must run as a replica set (init via `bin/shared/mongodb-init-replica-set.js`).
- Some workspaces listed in root `package.json` (analytics, idp, templates, …) aren't present in this fork — don't assume their code exists.
