# SDIS — Running / Previewing This Project

## What this project is

TypeScript modular monolith (Node 22+, CommonJS) with **no HTTP dev server
script** of its own. The verified entrypoints are the npm scripts in
`package.json`:

```text
npm run build      # tsc -p tsconfig.json  -> compiles src/ and tests/ to dist/
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src tests --max-warnings 0
npm test           # node --test --test-concurrency=1 "dist/tests/**/*.test.js"
npm run verify     # clean + build + typecheck + lint + format:check + test + audit
```

Source of truth for commands: `package.json` scripts and `docs/TESTING_STRATEGY.md` §5.
The compiled `dist/` tree is a build artifact and is gitignored; a fresh
checkout must run `npm install` and `npm run build` before anything else.

## Reproducing the artifacts (fresh checkout)

1. Install pinned dependencies:

   ```bash
   npm ci
   ```

   (uses `package-lock.json`; falls back to `npm install` if the lockfile is missing)

2. Compile TypeScript to `dist/` (required by every other command):

   ```bash
   npm run build
   ```

3. Environment: **no real env file exists**. `.env.example` is a template with
   no secrets and no required values. If a real `.env` / `.env.local` ever
   exists in the main checkout, copy it here and adapt PORT:

   ```bash
   # only if it exists in the main checkout
   cp ../.env.local .env.local
   ```

   Never symlink; never commit real values.

## Running / previewing

There is no `npm run dev` script. Two supported ways to see the project live:

### Option A — static project overview page (what the preview uses)

A standalone, dependency-free `preview/index.html` documents the project
status (Foundation gate state), module matrix, API surface, and verification
results, with links into `docs/`. It is kept in sync with
`docs/PROJECT_STATUS.md` by hand — update it when the verification results
change (no generator script; keep it dependency-free).

**Preview mode in use (registered):** a tiny dependency-free static server
(`preview/server.mjs`, node:http only) rooted at the REPOSITORY so that both
trees resolve:

- `/` → 302 → `/preview/index.html` (the overview page)
- `/preview/*` → the overview page and any of its assets
- `/docs/*` → the Foundation documentation (markdown as text/plain)

Nothing else is served; loopback-only; no writes. Run it with:

```bash
node preview/server.mjs          # PORT env honored if a positive integer
```

Default preview port: **4173** (free at registration; the project claims no
default port — record any change here). Registered URL:
`http://127.0.0.1:4173/` (server log:
`.freebuff/preview-c86bb325-209f-4f69-8f1b-69140f405e4a.log[.err]`).

Any static server works too, but it must be rooted at the REPO (not at
`preview/`), or the `../docs/…` links will 404:

```bash
npx serve .        # repo-rooted; then open /preview/index.html
npx http-server preview -p <port>   # overview only — doc links will not resolve
```

### Option B — drive the real HTTP transport (proof harness)

The transport (`src/transport/`) is exercised by the tests themselves. To see
the API alive, the test harness starts `createSdisHttpServer` on an ephemeral
port inside `tests/transport/http-postgres.test.ts` (embedded disposable
PostgreSQL on port 55442). Run:

```bash
npm run build && node --test --test-concurrency=1 "dist/tests/transport/*.test.js"
```

**Do not** run the full `npm run verify` just to preview — it boots ~9
disposable embedded PostgreSQL instances and takes ~2 minutes.

## Port notes

- No default port is claimed by the project (`PORT=3000` in `.env.example` is
  template-only). The preview server defaults to **4173** and honors a
  positive-integer `PORT` env (it deliberately ignores `PORT=0`, which some
  sandbox environments export — that would bind a random ephemeral port).
- Embedded PostgreSQL test ports: 55433–55442 (see `tests/infrastructure/`).
