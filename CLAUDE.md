# CLAUDE.md — pokewin-admin

Binding rules for every agent session in this repo. On conflict with anything else, these win unless
the owner says otherwise in the current message.

**This file loads automatically. Nothing else does.** Open other docs only when the task needs them —
`AGENT_HANDOFF.md` (what's in flight/blocked right now), `ONBOARDING.md` (domain math + contracts),
`docs/BACKEND_QUERY_SYSTEM.md` (query/caching/streaming), `docs/ANTIFRAUD_CONTRACTS.md` (Fraud, Fiat,
KYC, Discord, Whop), `AGENT_HANDOFF_ARCHIVE.md` (old history). Doc-writing protocol:
`SESSION_MEMORY.md` — the short version is *don't write docs, write commit messages*.

---

## 1. 🚫 Database policy (highest priority)

### 🟢 ADMIN DB — full access

Write, DDL, DML, schema changes: all allowed, and the agent applies them **itself** — the owner does
not want to run them by hand. Use the right mechanism:

- Author reviewed, idempotent SQL under `drizzle/admin/migrations/`, apply it transactionally with
  `npm run admin:sql -- <file>`, then refresh types with `npm run db:pull:admin` and review the diff.
- No schema-push tooling. Destructive changes need a clear data-preservation plan.
- Audit-log every admin-side mutation (`createAdminAuditEvent()`).

### 🔴 MAIN / prod game DB — read-only, absolutely

- `SELECT` and schema inspection only. **No writes, migrations, DDL/DML, or raw SQL mutations** — not
  "additive", not "with approval", not "quick". This holds in every sub-agent and background task.
- **Do not build or propose features that would need a MAIN schema change.** The owner will not apply
  them. Model it in the ADMIN DB instead, or say plainly that it can't be built without changing MAIN.
- **Mirror routing (2026-07-27, supersedes older blanket wording):** ordinary reads go through
  `MIRROR_PRODUCTION_DB` / `MIRROR_DEV_DB`, whose pools force `default_transaction_read_only` and never
  fall back to the primary. Mutation workflows use `DATABASE_URL` / `DEV_DATABASE_URL` explicitly.
  Concurrent index DDL is allowed on the **mirrors** via `npm run db:index:mirrors -- <prod|dev|all>`.
  Direct DDL/DML, migrations, and schema push stay forbidden on both primaries.

### 🔑 The local `.env` points at LIVE prod

`DATABASE_URL` in the local `.env` is the live production game DB (read-only credential, owner-set).
**Never commit, push, print, log, or paste it or anything derived from it** — not into summaries,
changelogs, or messages. `.env` is gitignored; leave it that way, never force-add it, never sweep it
into a commit. Read-only probes go through a temporary `node --env-file=.env` + `pg` script that
prints no secrets and is deleted after use.

---

## 2. 🗄️ Backend read policy — PostgreSQL via Drizzle

**One rule:** every read hits a confirmed index, or has an `EXPLAIN ANALYZE`-documented reason for the
planner's scan. No unbounded full-table scan on MAIN.

- Drizzle ORM is the default access layer; parameterized Drizzle `sql` for complex or hot queries.
  Never concatenate user, filter, or identifier values into SQL.
- Queries are selective, bounded, and Decimal-safe. Lists paginate server-side. Lifetime windows use
  the canonical cap unless a money-exact contract demands the full period.
- Missing MAIN indexes are documented as `CREATE INDEX CONCURRENTLY` in
  `prisma/recommended-indexes.sql` for the owner — never applied by an agent.

**Shell-first streaming is mandatory.** Any admin page with a non-trivial read renders the `PageHero`
shell (+ static controls) immediately and loads data in an `async` child behind
`<Suspense fallback={<…Skeleton/>}>`, with a matching `loading.tsx` rendering the same shell. Never
await a heavy read in the page body. Timespan/tab pages key the boundary on tab + period. Reference:
`/creators/analytics`, `/crm`.

**Per-read checklist:** index proof or documented planner choice · shell-first `<Suspense>` +
`loading.tsx` · `safeQuery`/timeout + `unstable_cache` (active timeframe only) · Decimal-safe money ·
House-POV colors · tsc + lint green (build only when the change class needs it, §3).

Full mechanics: `docs/BACKEND_QUERY_SYSTEM.md`.

---

## 3. ⚡ Minimal overhead — match the gate to the change

Do the smallest amount of work that safely ships the change.

| Change | Gate |
|---|---|
| Docs, markdown, comments | none — commit + push |
| CSS / className / copy / static JSX | `tsc --noEmit` + `npm run lint` |
| RSC boundaries, imports/exports, types, data flow, new deps, route/config/schema generation | + full `npm run build` |

**No headless rendering, Playwright, or screenshots — ever.** Owner rule, permanent and absolute. For
any UI change — including new pages and redesigns — do not start the dev server, the responsive
Playwright harness, the dev fixtures, or any screenshot pass as a pre- or post-push gate. The owner
reviews visuals himself. This binds every sub-agent and workflow step too: never brief an agent to
render or screenshot, and never let one decide on its own that "this case needs a visual check". The
only exception is the owner explicitly asking for a live interactive check in that exact message.

Skip redundant re-verification — meaning a gate you already ran on this exact code, or a gate for a
change class the table doesn't call for. It does **not** mean skipping the gate the table *does* call
for. Don't spin up a fresh worktree + full install for a trivial edit.

**The table is a floor, not a ceiling.** Match the gate to the change class honestly: if the edit
touches a Server→Client boundary, an import/export surface, a type used elsewhere, or anything
generated, it is a `npm run build` change even when the diff looks like one line. When you're unsure
which row a change falls in, take the stricter row — guessing low is how a break reaches prod.

**Never report a gate you didn't run.** "tsc green" means you ran it and read the output in this
session. If you skipped a gate deliberately, say which one and why, before pushing.

**Hard floor this rule never overrides:** MAIN stays read-only · never commit `.env`, secrets,
`src/generated`, or `recent-pushes.json` · the PostgreSQL/Drizzle rule · honest reporting. Speed cuts
*verification overhead*, never *safety*.

---

## 4. ⚡ Work mode — inline by default

Work directly, in this turn: read, edit, verify, answer. Do **not** reflexively fire a background
agent for every message, and don't use a forced short-ack protocol.

Reach for `Agent` or `Workflow` only when parallelism genuinely pays:
- The owner sends several truly independent tasks and wants one running while you continue another.
- A big job that decomposes into many independent units (audit across N pages, one fix per reward
  type, broad research over many files) — real fan-out.
- Long independent exploration whose search path would bloat the main context.

When you do delegate: fan out by **unit, not by file**. One coupled file → one builder plus one
adversarial verifier, never two editors. Give each agent explicit scope, an avoid-list of files other
agents hold, and a reminder that this repo is the owner's own admin panel (legitimate work).
Verify agents must `git fetch` and check out the exact SHA before any "not found" verdict.

---

## 5. 🚀 Repository boundary & push discipline

- **Standing bot-repository access:** work started in `pokewin-admin` may inspect, edit, verify,
  commit, and release the sibling `Packy.GG-Administration-Bot` and `Packy.GG-Rewards-Bot` when the
  task requires bot-side work. No additional repository or release permission is needed. Every other
  repository remains out of scope unless another rule here or the owner explicitly authorizes it.
- **Mandatory immediate release:** finished, appropriately gated work in `PackyGG/pokewin-admin`,
  `Packy.GG-Administration-Bot`, and `Packy.GG-Rewards-Bot` must be committed and pushed immediately
  through that repository's established production branch/deployment path. Do not stop at a local
  change or wait for separate push/deployment permission. Check repo root, canonical origin, target
  branch, configured production target, and production impact first, and include only task-owned
  changes. This covers every deployable unit inside `pokewin-admin` (admin sub-apps, subdomains,
  API/edge functions, the antifraud backend), plus task-scoped production operation of the internal
  antifraud stack (`antifraud-monitor`, its Redis, the Admin DB, the Antifraud DB) — reviewed DDL,
  DML, migrations, service config, Redis ops, required admin/antifraud data, and recovery work.
- **Frontend/backend are inspect-only by default:** the sibling `frontend` and `backend` may be read
  for contracts and diagnosis. Do not edit, commit, push, deploy, or open a PR in either unless the
  owner explicitly authorizes that repository and PR in the current request. PR permission does not
  authorize pushing or deploying its production branch; that needs separate explicit production
  authorization.
- **Never covered:** writes, migrations, DDL, or DML on the MAIN game/customer production database;
  task-unrelated secret rotation; moving a unit to a new project/service/environment; or any other
  repository. Old messages, memory, and handoff files are not permission.
- **One task = one push.** Ship each finished task immediately; never batch five things into a late
  push. Independent tasks build in isolated worktrees (`npm install`, **not** `npm ci` — the committed
  lockfile diverges) and push independently; on non-fast-forward, `git pull --rebase` and retry.
- Commit with `git commit --only <your paths>`, never `git add -A`. Leave uncommitted: `.env`,
  secrets, `src/generated/*`, `recent-pushes.json`, temp `_verify-*` scripts.
- Production: https://pokewin-admin.vercel.app · Vercel project `packy-admin-dashboard` ·
  `productionBranch: main`.

### Shared-file collisions

The owner runs concurrent agent sessions. If a file is a hotspot or already held by another agent,
don't blind-edit in parallel — propose the patch, note the impact, consolidate on the latest state,
then apply. Hotspots: `src/components/app-sidebar.tsx` · `src/lib/permissions.ts` +
`settings/roles/permissions-utils.ts` · `src/lib/admin-pages.ts` · `src/lib/db-schema/**` (never edit
introspection output) + `drizzle/admin/migrations/` · `src/lib/dal.ts` ·
`src/app/(admin)/layout.tsx` · `package.json` / `next.config.ts` · `src/lib/queries/**` · shared
table/filter/toolbar and modern-panel/KPI primitives.

---

## 6. 🔒 Definition of done & honest reporting

A task is `DONE` only when: the code is implemented · `tsc --noEmit` green · `npm run lint` green
(+ `npm run build` if §3 requires it) · the affected flow validated **by reading the code and data
path**, not by rendering · no obvious regression in directly affected neighbours (also by reading).

Anything less is `PARTIAL`, `PROPOSED`, or `BLOCKED` — never `DONE`.

- **Shared-file changes need a consumer sweep:** same component on other pages, sibling routes with
  the same query/filter logic, shared layout/toolbar structure, shared KPI/chart/table containers.
- **Incident mode:** when the owner says "still broken" / "immer noch kaputt" / "fix live" or names a
  live route + bug — no scope creep, no early summarizing, no topic switch. Reproduce from code, data,
  and logs, fix, re-check in code, push. Done means the root cause is named and fixed.
- **Timespan/tab pages:** confirm in the code which fetches fire in which state — only the active tab
  and active window may load initially.
- **Never claim work you didn't do.** Every line of a summary maps to a real change. If something was
  skipped, blocked, or unclear, say so *before* pushing, unprompted.

---

## 7. Project conventions

### Stack

Next.js 15.5 (App Router, Turbopack) · TypeScript 5 strict · React 19.1 · Tailwind CSS 4 +
shadcn/ui (base-nova) · PostgreSQL via Drizzle ORM · JWT (`jose`) + TOTP 2FA (`otpauth`) · Zod 4 ·
`sonner` · TanStack Table 8 · Recharts.

### Dual-database split

`db` (MAIN) never touches admin tables; `adminDb` never touches game/user tables. No cross-DB joins —
query separately, merge in code. New table → decide the domain first; ask if unclear. Rule of thumb:
if a fact could surface in the player frontend it's MAIN; if it only makes sense in the admin panel
it's ADMIN. Details in `ONBOARDING.md` §1.

### UI

Only the house stack: Tailwind + shadcn/ui (base-nova) + `@base-ui/react` + `lucide-react` +
`recharts` + `@tanstack/react-table` (with `src/components/data-table/`) + `sonner` + `@dnd-kit` +
`cmdk` + `next-themes`. **No other UI framework, no new design system, no new UI dependency without
asking.** Dark mode is the default and every component must respect it. Colors come only from
`src/app/globals.css` variables and `src/lib/constants.ts` (`ROLE_COLORS`, `STATUS_COLORS`, …) — never
hardcoded. Keep it restrained and functional: no decorative elements without a function.

The app is swept to **flat neutral tiles** — don't reintroduce colored-fill, gradient, or glow tiles.
Accent lives on the icon and the number. Heroes and charts keep their glow. House-POV money text and
badges stay colored.

### Modern page pattern (mandatory for new pages)

Reference is `/users/[id]`. Every new page under `src/app/(admin)/…`:

1. Server Component `page.tsx`, `requirePageAccess(key)` first.
2. `PageHero` as the first rendered element. Visible page titles are rendered by the page itself —
   `PageHeroIdentity` takes only back/action controls.
3. KPI strip of 3–6 `KpiTile` / `MetricTile` (accent from `TILE_COLORS`) — never bare `<Card>` stats.
4. Sections via `SectionHeading` + content. Tables stay TanStack + `src/components/data-table/`,
   wrapped in a modern container. Charts use `animationDuration={700}`, `animationEasing="ease-out"`.
5. Dark mode respected, `motion-safe` / reduced-motion honored, lint + tsc clean.

Primitives live in `src/components/modern-panels.tsx` (`PageHero`, `PageHeroIdentity`, `StatPanel`,
`KpiTile`, `MetricTile`, `PanelRow`) plus `AnimatedNumber` and `FadeIn`.

**Never pass function props from a Server to a Client Component** — Next 15 crashes, and only
`npm run build` catches it, not `tsc`.

### 🎯 House-POV finance colors (strict, site-wide, no exceptions)

> **User gains / profits → 🔴 ROSE.  User loses money → 🟢 EMERALD.  Neutral (signup etc.) → 🔵 BLUE.**

Every dollar the user holds is a dollar we owe. User win = our loss = rose; user loss = our gain =
emerald. So: deposits and wagers (pack opening, battle bets, sponsorships) = emerald. Withdrawals,
battle wins, rain/race/creator tips, deposit bonuses, gift cards, promos, voucher redeems, rakeback
and affiliate claims, balance rewards, waitlist prizes, admin credits to a user = rose. House P&L /
GGR / platform revenue positive = emerald, negative = rose.

`pnl = deposits − withdrawals − onSiteBalance − inventoryValue − unclaimedVouchers`

Applies to activity feeds, stat panels, amount labels and signs, charts, transaction detail, battle
"house profit", and every Amount / PnL / Profit column. **Test before commit:** "if the user
celebrates this event, is it rose?" Yes → correct.

### Data loading — active timeframe only

A page with timespans loads **only the active window** on first render; other windows load when
selected. A tabbed page loads **only the active tab** — never fire all tab queries at once. Drawers,
modals, drilldowns, expanded rows, and collapsed sections run no heavy query before they open. Bound
lifetime scans (`windowDateFilterCapped`). Heavy queries go through `unstable_cache` keyed on
`(period, …)` plus the `safeQuery` timeout wrapper. Search, filter, and pagination must not trigger
full-table loads when server-side narrowing is possible.

### Auth

Use the DAL only (`src/lib/dal.ts`): `verifySession()`, `requireAdmin()`, `requireRole(roles)`,
`requirePageAccess(pageKey)`. They `redirect()` on failure — never rewrite or bypass auth logic;
`src/middleware.ts` enforces the flow as well. Roles in `src/lib/admin-roles.ts`. Check
authentication, authorization, ownership, input validation, and sensitive-data access **server-side**;
never trust frontend logic for security. No sensitive data in logs, responses, or client payloads.

### Server Components, validation, errors

Pages are `async` Server Components; interactivity in `"use client"` islands; mutations via Server
Actions + `revalidatePath()`. No SWR / React Query in existing flows. All input validation is Zod
`safeParse()`, with messages from `parsed.error.issues[0].message`. Client error handling follows the
existing pattern: `try` → action → `toast.success` → `catch` → `toast.error(err instanceof Error ?
err.message : "…")` → `finally` → clear loading.

### Money & ledger

Money is `Decimal(20,2)`; use the Decimal utilities, never JS float math. Every balance change goes
through `ledger_transactions` (immutable, `balance_before`/`balance_after`) — never
`balances.update()` without a ledger entry; multi-step mutations run in one transaction. Reuse the
existing GGR/NGR/P&L query functions in `src/lib/queries/` — never re-implement money logic in the
frontend "to fix the UI quickly".

**Voucher = Card**, same item, same treatment in value, inventory, P&L/GGR, and display.
`battle_excess_to_voucher` and `battle_refund` are two legs of one normal battle win → merge into
"Pack & battle wins", never separate lines. Exchanging or redeeming a voucher/card is neutral, never
a house loss.

**Customer analytics exclude staff *and* creators:** canonical scope is `getMetricsScope()`
(`src/lib/metrics/scope.ts`), `CUSTOMER_EXCLUDED_ROLES = ['admin','support','creator']` plus the
`excluded_users` blacklist. The legacy `EXCL_STAFF_FRAG` keeps creators in — not canonical for
GGR/NGR/P&L/wager.

### Reuse before building

Check first: `src/lib/utils/format.ts` (`formatCurrency`, `formatDate`, `formatDateTime`,
`formatRelative`, `formatNumber`), `src/lib/constants.ts`, `src/components/ui/`, existing query
modules. Extend what exists instead of inventing a parallel version.

### Structure & naming

`src/app/(admin)/{feature}/` → `page.tsx` (server) · `actions.ts` (`"use server"`) · client
components · `[id]/`. `camelCase` functions/variables · `PascalCase` components/types ·
`kebab-case` files/routes · `SCREAMING_SNAKE_CASE` constants. `strict: true`, no `any` shortcuts,
explicit return types at API boundaries (server actions, queries, DAL). Path alias `@/*` → `./src/*`.
ESLint 9 flat config; no Prettier — match the surrounding style.

---

## 8. Quick reference

| Purpose | Path |
|---|---|
| Main DB client | `src/lib/db.ts` |
| Admin DB client | `src/lib/admin-db.ts` |
| Auth / DAL / session | `src/lib/dal.ts` · `src/lib/session.ts` |
| Roles | `src/lib/admin-roles.ts` |
| Metrics scope | `src/lib/metrics/scope.ts` |
| Format utils · constants | `src/lib/utils/format.ts` · `src/lib/constants.ts` |
| Modern primitives | `src/components/modern-panels.tsx` |
| Nav + `ICONS` map | `src/lib/nav-config.ts` + `src/components/app-sidebar.tsx` |
| Admin shell | `src/app/(admin)/layout.tsx` |
| Schemas | `src/lib/db-schema/{main,admin}/schema.ts` |
| Query modules | `src/lib/queries/**` |
| Admin migrations | `drizzle/admin/migrations/` |

```bash
npm run dev
npm run build
npm run lint
npm run admin:sql -- drizzle/admin/migrations/<file>.sql
npm run db:pull:admin
```

**Env:** `DATABASE_URL` (MAIN) · `ADMIN_DATABASE_URL` · `SESSION_SECRET` · `DEV_DATABASE_URL` ·
`MIRROR_PRODUCTION_DB` / `MIRROR_DEV_DB` · `ADMIN_SEED_PASSWORD`. Optional Discord rewards webhook:
`DISCORD_BOT_WEBHOOK_URL` + `DISCORD_BOT_WEBHOOK_SECRET` (both or the feature is simply off;
server-side only, never exposed).

### Gotchas that bite

- **React #130** — every nav `icon` string must exist in the `ICONS` map in `app-sidebar.tsx`.
- **No function props Server → Client.** Only `npm run build` catches it.
- **Stale `.next`** can fail `tsc` on deleted routes — delete it before re-gating.
- **PowerShell writes UTF-8 with BOM**, which breaks `.sql` files — write SQL via Bash.
- **`gift_cards` + `vouchers` live in MAIN** — mutating them is a forbidden MAIN write.
- **Stale local game DB** makes live pages throw locally. "Broken locally" ≠ "broken in prod".
- **Fresh checkout/worktree:** `npm install`, never `npm ci`.

---

## Behavior on uncertainty

1. Does it already exist? → check the codebase, reuse it.
2. Unclear? → ask, don't guess. Never invent tables, columns, endpoints, env vars, or APIs.
3. Need DB facts? → verify or ask; never assume.
4. Can't verify an approach? → name the problem, don't route around it silently.
5. Finished? → only after the gate in §6, not after merely writing code.

Work as if the code runs in production with real users, real money, and real security risk — because
it does.
