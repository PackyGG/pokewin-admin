# AGENTS.md — pokewin-admin

## MAIN mirror routing

Use `MIRROR_PRODUCTION_DB` / `MIRROR_DEV_DB` for ordinary MAIN reads and
`DATABASE_URL` / `DEV_DATABASE_URL` only through explicit application mutation
clients. Mirror reads fail closed and force read-only sessions. Concurrent
index DDL is allowed on the mirrors; direct agent DDL/DML on primaries is not.

Agent rulebook for Codex/Cursor sessions in this repo. **The binding rules live in [`CLAUDE.md`](./CLAUDE.md) — read that first.** This file used to carry its own full copy of those rules (~65KB); as of 2026-07-12 it's a pointer instead, so the rules have exactly one source of truth and can't drift out of sync. `CLAUDE.md` covers: Prod-DB policy, the PostgreSQL/Drizzle query rule, the minimal-overhead speed rule, push discipline, browser-verification/done-criteria, UI & design conventions, dual-DB architecture, auth/permission patterns, and the file organization/naming conventions.

## Repository and production boundary

Agents working from `pokewin-admin` may also access, inspect, edit, verify,
commit, and release the sibling `Packy.GG-Administration-Bot` and
`Packy.GG-Rewards-Bot` repositories when a task requires bot-side work. This is
a standing cross-repository exception; no additional permission is needed.
Other repositories remain out of scope unless a rule below or the owner
explicitly authorizes them.

Finished, appropriately verified task changes in `pokewin-admin`,
`Packy.GG-Administration-Bot`, and `Packy.GG-Rewards-Bot` must be committed and
pushed immediately through each repository's established production
branch/deployment path. Do not stop at a local change or wait for separate push
or deployment permission. Before pushing, verify the repository root,
canonical origin, target branch, configured production target, and production
impact, and include only task-owned changes.

The exception covers every deployable item stored inside this repository:
admin-dashboard sub-apps and subdomains, API/serverless/edge functions, and
repository-contained services such as the Antifraud backend. Agents may work
on, verify, commit, and immediately ship these items to their existing
production targets without asking for separate per-component permission. If a
component does not deploy automatically from `origin/main`, agents may deploy
it to its already-configured production target after its task gate passes.

The standing exception also authorizes full task-scoped production operation
of the repo-contained Antifraud stack: `antifraud-monitor`, its Redis, the
Admin DB, and the Antifraud DB. Agents may apply reviewed migrations, change
service configuration, operate Redis, and make required Admin/Antifraud data
changes without separate permission after verifying the exact production
target and recovery impact.

The sibling `frontend` and `backend` repositories may be read and inspected for
contracts and diagnosis. Do not edit, commit, push, deploy, or open a PR in
either repository unless the owner explicitly authorizes that repository and
PR in the current request. Even with PR permission, do not push or deploy its
production branch without separate explicit production authorization.

MAIN game/customer production databases remain strictly read-only. The Admin
DB and Antifraud DB may be operated fully for task-scoped work, including
reviewed DDL, DML, migrations, configuration, and recovery work, after verifying
the exact target, production impact, and recovery path. This authority does not
extend to unrelated secret rotation, moving components to new infrastructure,
or any other repository.

---

## 🧠 Session Memory protocol

**Nothing mandatory on session start** beyond what Cursor already injects (`CLAUDE.md` /
always-applied lean rules). Do **not** open `AGENT_HANDOFF.md`, `ONBOARDING.md`, or large docs
before every tool call — that is what makes Cursor slower over time.

- Open `AGENT_HANDOFF.md` only when in-flight / blocked / file locks matter (board ≤ 200 lines).
- Prefer git history for what shipped; keep the handoff a **board**, never a changelog.
- Before DONE on substantive work: update the board for open/blocked/locks only; promote durable
  facts to `ONBOARDING.md`. Skip pure Q&A with zero new facts / zero code changes.

Full protocol: `SESSION_MEMORY.md`.

---

## Cursor Cloud specific instructions

### Services (single app + two Postgres DBs)

| Service | Required | Notes |
|---|---|---|
| **Next.js dev server** | Yes | `npm run dev` → `http://localhost:3000` (Turbopack) |
| **PostgreSQL — Admin DB** | Yes | `ADMIN_DATABASE_URL` — auth, audit, admin-only tables |
| **PostgreSQL — Main DB** | Yes (most pages) | `DATABASE_URL` — game data; **read-only** in agent policy |
| **Backend API / Packy WS** | Optional | Creator mutations, live chat — need `BACKEND_API_*` / upstream WS |

No Docker Compose in repo. Databases are external hosted Postgres **or** a local Postgres instance on the VM.

### Dependency install (update script)

`npm install` only. Refresh checked-in Drizzle schema snapshots only after a
database catalog change (`npm run db:pull:main` / `npm run db:pull:admin`).

### Environment

Create `.env.local` (gitignored) with at minimum:

- `ADMIN_DATABASE_URL`
- `DATABASE_URL`
- `SESSION_SECRET`
- `ADMIN_SEED_PASSWORD` (for `npm run admin:seed`)

Drizzle tooling reads `.env` / shell exports and does **not** load `.env.local`
automatically. Export the variables or duplicate the required keys into `.env`
before introspection or admin SQL work.

**Preferred for real work:** use the owner's hosted `ADMIN_DATABASE_URL` + `DATABASE_URL` secrets (Cursor Cloud secrets). **Ephemeral VM fallback:** local Postgres 16 (`sudo pg_ctlcluster 16 main start`), two databases, then:

```bash
export $(grep -v '^#' .env.local | xargs)
npm run db:pull:main
npm run db:pull:admin
npm run admin:seed
```

Admin schema changes use reviewed, idempotent SQL under
`drizzle/admin/migrations`: `npm run admin:sql -- <file>`, followed by
`npm run db:pull:admin`. Never run schema-push tooling against MAIN.

### Lint / typecheck / build / test

```bash
npm run lint          # ESLint (warnings exist; 0 errors required)
npx tsc --noEmit      # TypeScript
npm run build         # Authoritative gate (RSC boundary errors surface here)
E2E_USE_EXISTING_SERVER=1 npm run test:e2e   # Playwright (needs E2E seed + TOTP secret)
```

### Dev server

```bash
npm run dev
# or reuse: E2E_USE_EXISTING_SERVER=1 npm run test:e2e
```

Use **tmux** for long-running `npm run dev` in Cloud Agent VMs.

### Hello-world verification

1. `GET /` → redirects to `/login` (307).
2. `npm run admin:seed` → `admin@packy.gg` (password = `ADMIN_SEED_PASSWORD`).
3. Playwright `e2e/tests/auth.spec.ts` — real `/login` + `/verify-2fa` → `/dashboard` (seed E2E admin + `E2E_ADMIN_TOTP_SECRET` in `.env.local`; `npm run test:e2e:seed` may need `updated_at` on INSERT against a fresh local admin schema — set via SQL `NOW()` if seed fails).
4. Empty local Main DB: dashboard KPIs may be zero/empty; auth shell still proves the stack.

### Gotchas

- **Stale local Main DB** vs prod — many analytics pages need real data; use `src/app/responsive-fixture/*` or hosted read-only `DATABASE_URL`.
- **`.next` stale** — delete `.next` if `tsc` references removed routes.
- **Playwright** — `npx playwright install chromium` once per VM; auth tests use real forms (no cookie bypass except `e2e/responsive/mint-session.ts` harness).

---

## Behavior on uncertainty

1. **Exists already?** → check the codebase, reuse.
2. **Not clear?** → ask, don't guess.
3. **Need DB/domain info you don't have?** → ask the owner, never assume.
4. **Verified?** → if no: name the problem, don't paper over it.
5. **Done?** → only after verification, not after merely writing code.
6. **Visible/testable in the browser?** → check before saying `DONE`.
