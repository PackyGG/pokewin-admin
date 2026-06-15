# ClickHouse CQRS — Security / DB-Safety Verdict

**Verdict:** ✅ **SAFE TO MERGE**

**Date:** 2026-06-15 · **Feature:** `m4-final-gate-verdict` · **Milestone:** `dashboard-audit`
**Reviewed SHA:** `0280e90e477a2818996d4e72852c0936e7a9e36a` (`main` == `origin/main` at review time)
**Scope reviewed:** the ClickHouse CQRS read-engine mission diff — the 13 mission commits from
`04b6cc37` (m1-extract-ggr-window-helper) through `0280e90e` (m4-comparison-browser-flows),
covering boundary hardening, Phase-2A parity (trend-series, realized-pnl, window-metrics),
comparison wiring + observability, and the behavior-neutral `/dashboard` audit.

This verdict reads `SAFE TO MERGE` only because **every** sub-check below passed on the single
reviewed SHA. If any sub-check had failed it would read `NOT SAFE TO MERGE` with the failing item.

---

## 1. Full gate — green end-to-end on ONE SHA (no stale `.next`)

`.next` was deleted before the run; all four steps executed in order on `0280e90e`, no step skipped.

| Step | Command | Result | Assertion |
|---|---|---|---|
| 1 | `npx tsc --noEmit` | **exit 0**, 0 errors | VAL-CROSS-001 |
| 2 | `npm run lint` | **exit 0**, 51 warnings / 0 errors — **0 new vs baseline** (~53–56 pre-existing; none in `src/lib/clickhouse/**` or any mission-touched file; CQRS `no-restricted-imports` boundary rule clean) | VAL-CROSS-002 |
| 3 | `npm run build` | **exit 0** (prisma generate ×2 + next build; no RSC client/server boundary error) | VAL-CROSS-003 |
| 4 | `npm run test:parity` | **exit 0**, 69/69 tests + limits 51/51; incl. CH read-only guard, **direct + transitive** import-boundary walk, and the documented negative control | VAL-CROSS-004 |

Full gate green on the same SHA, no stale `.next`, no step skipped → **VAL-CROSS-005 PASS**.

Boundary/guard fixtures confirmed present in the `test:parity` run:
- `clickhouse read layer never DIRECTLY imports a Postgres/Prisma client` ✔
- `clickhouse read layer reaches no Postgres/Prisma client (TRANSITIVE walk)` ✔
- `negative control: reintroducing window-metrics -> @/lib/queries/ggr -> getDb FAILS the walk` ✔
- `ClickHouse client stays read-only (readonly:"2", no writable override)` ✔
- `clickhouseRead exposes only query() — no insert/command/exec` ✔
- `assertReadOnlySql throws ClickHouseReadOnlyError` ✔

---

## 2. Diff-wide DB-safety sweep

Sweep performed over the concatenated per-commit diffs of all 13 mission commits
(`git show 04b6cc37 980ed4b8 f7ac1024 23e6ba62 b334e1ab e9719bac a8d9b0d6 f4a94d10 146643c6 013c9fd6 07f9ba43 54103a60 0280e90e`),
plus `git ls-files` / `git status --porcelain` / `.gitignore` inspection on the reviewed SHA.

| Sub-check | Assertion | Result | Evidence |
|---|---|---|---|
| **Zero MAIN/prod Postgres writes** | VAL-SAFETY-010 | ✅ PASS | Grep of all added (`^+`) diff lines for `.create/.update/.delete/.upsert/.*Many/$executeRaw[Unsafe]/$queryRawUnsafe` + DML/DDL verbs (`INSERT/UPDATE/DELETE/DROP/ALTER/CREATE TABLE/TRUNCATE`) on `getDb()`/`getProdDb()` returned **only markdown prose** in `AGENT_HANDOFF.md` / `CLICKHOUSE_CQRS_ESCALATIONS.md` (describing patterns), **no code write**. No `prisma migrate`/`db push` on `prisma/schema.prisma`. The only write *mentioned* is the **pre-existing** `adminDb.$executeRaw UPDATE` in `getCryptoFeeProfitCounter` — an **ADMIN-DB** write (not MAIN/prod), documented in ESC-3 and **left unchanged** by this mission. |
| **Admin-DB changes via db push/db execute, never migrate** | VAL-SAFETY-011 | ✅ PASS (vacuous) | `git show --name-only` over all mission commits shows **no** `prisma/schema*`, `prisma/admin*`, `prisma/migrations/*`, or `src/generated/*` path touched. No admin schema/migration files added → nothing applied via `migrate`. |
| **No secret/.env/connection-string committed, printed, or logged** | VAL-SAFETY-012 | ✅ PASS | Grep of added diff lines for `postgres://`/`postgresql://`/`clickhouse://`/`user:pass@host`/`DATABASE_URL=…`/`CLICKHOUSE_PASSWORD=…`/`password:`/`secret:`/`sslmode=` returned **none**. Only tracked env file is `.env.example` (allowed via `.gitignore` `!.env.example`) — verified to contain **blank placeholders only**, no real DSN. Observability logging redacts to error class/name (`logError`/`logQueryFailure`): no raw SQL/params/rows/stack, non-Error JSON sliced to 500 chars. |
| **Probe/compare harnesses remain UNCOMMITTED** | VAL-SAFETY-013 | ✅ PASS | `git status --porcelain` shows `scripts/_compare-*.mjs`, `scripts/_probe-*.mjs`, `scripts/_verify-*.mjs` all as `??` (untracked). `git ls-files` matches `_probe-/_compare-/_verify-` → **none tracked**. `.gitignore` covers them. |
| **No `src/generated/*` committed** | VAL-SAFETY-014 | ✅ PASS | `git ls-files | grep src/generated/` → **none**. `git status` after `prisma generate ×2` shows no `src/generated/` paths. `.gitignore` has `/src/generated` + `/src/generated/prisma`. |
| **No surface flipped to clickhouse mode; flag default chain ends in `off`** | VAL-SAFETY-015 | ✅ PASS | `getAdminReadMode` (`src/lib/feature-flags/admin-read-source.ts`, unmodified by this mission) resolution chain: dormant→`off` → env override → Edge Config per-surface → Edge Config `__default` → **final fallback `"off"`**. All three new hooks (`compareWindowMetrics`/`compareTrendSeries`/`compareRealizedPnl`) gate on `if (mode !== "comparison") return;` — they never set/serve `clickhouse`. No tracked config (`.env*`/`*.json`/`vercel.json`) sets any `ADMIN_READ_SOURCE__<SURFACE>=clickhouse`; the only `=clickhouse` strings in the repo are documentation of the *future* cutover path and conventional-commit `"scope":"clickhouse"` metadata. |

---

## 3. Behavior-neutrality (corroborating)

- Each comparison hook is fire-and-forget (`void compareX(...)`) and never-throw (whole body in
  `try/catch` whose catch only `logError("clickhouse.compare.<surface>", …)`), gated on
  `getAdminReadMode("<surface>") === "comparison"` before any blacklist fetch or CH call.
- With every new surface `off` (the default) or ClickHouse dormant, the hooks return immediately →
  served payload byte-identical to pre-mission `main` (proven end-to-end in `m4-comparison-browser-flows`,
  VAL-CROSS-006..012, validated `passed`).
- The CH read layer imports no `@/lib/db`/`@/lib/admin-db`/`pg`/prisma directly **or transitively**
  (enforced by the strengthened boundary test + negative control).

---

## 4. Open items (documented, NOT blocking — owner decisions)

These are behavior-affecting items deliberately left unchanged and recorded in
`CLICKHOUSE_CQRS_ESCALATIONS.md`; they do not affect this safety verdict:
- **ESC-1 / ESC-2** — realized-P&L and the P&L family use the legacy 2-role scope (keep creators)
  vs canonical 3-role `getMetricsScope`. CH was aligned to the PG twin for parity; PG twins unchanged.
- **ESC-3** — `getCryptoFeeProfitCounter` performs an idempotent **admin-DB** (not MAIN/prod) write
  on the render path. Allowed under mission rules; relocation is a behavior change for owner decision.

---

## 5. Conclusion

All gate steps green on `0280e90e`, and all six DB-safety sub-checks pass with the evidence above:
no MAIN/prod writes, no admin migrations, no secret/.env/connection-string leakage, probe/compare
harnesses uncommitted, no `src/generated/*` committed, and no surface defaulted to `clickhouse`
(flag chain ends in `off`). The mission's changes are behavior-neutral until an explicit per-surface
flag flip, which is out of scope here.

**→ SAFE TO MERGE** (reviewed SHA `0280e90e477a2818996d4e72852c0936e7a9e36a`).
