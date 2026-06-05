# 🚪 Agent Handoff / Exit — pokewin-admin

> You are picking up a high-velocity, multi-workflow session on **pokewin-admin** (the Packy.GG staff admin dashboard). **Read this first**, then `ONBOARDING.md` (full architecture + domain knowledge) and `CLAUDE.md` (binding rules). This file is the live operating manual + current state snapshot.

---

## 🔴 STRICT OPERATING RULES — workflow + agents (non-negotiable)

**1. Workflow-first.** Begin EVERY non-trivial task with the `Workflow` tool (deterministic multi-agent orchestration). Workflows are the default, not the exception. Inline / single-background-agent is allowed ONLY for: a pure codebase question (no edit), ONE trivial 1-file fix, live troubleshooting, or an explicit "inline" from the owner.

**2. Multiple workflows for multiple tasks.** Run as many in parallel as the work allows — no cap. Keep the channel responsive: a new owner message is always a new task; pick it up immediately, never block.

**3. Fan out by INDEPENDENT UNIT, not by file.**
- Many independent units (many pages, many files) → **many parallel agents**, one per unit (`parallel()` / `pipeline()` inside the workflow).
- ONE coupled file/surface → **1 builder + 1 adversarial verifier**. NEVER put two editing agents on the same file — they collide/clobber. The "second agent" for coupled work is the verifier, not a second editor.
- Typical shapes: **discover → build → verify**, or **fan-out → synthesize/verify**.

**4. Build-agent contract (every worktree agent):**
- Work in an isolated git worktree (`isolation: "worktree"`). At start: `git fetch origin && git reset --hard origin/main`; copy the main checkout's `.env`; `npm install` (**NOT** `npm ci` — committed lockfile mismatch).
- Gate before push: `npx tsc --noEmit` + `npm run lint` (0 NEW warnings) + `npm run build` (exit 0). `npm run build` is authoritative — client→server boundary errors only surface there.
- Commit with `git commit --only <your files>` (**never** `git add -A`); always leave `src/generated/*`, `package-lock.json`, `recent-pushes.json`, `audit-artifacts/` uncommitted.
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Push: `git fetch origin && git rebase origin/main && git push origin HEAD:main`; retry on non-fast-forward. Do **NOT** remove your worktree — the orchestrator cleans up (junction-safe; also kill stray dev servers, e.g. a leftover `next dev` on :3000).

**5. Verify-agent contract:** `git fetch && checkout the EXACT commit` BEFORE reading — a stale tree caused a false-negative this session ("feature not found" when it was present). Adversarially re-check; cross-check any "not found" verdict against `git show <sha>`.

**6. DB policy (HARD):** **ADMIN DB = writable** (use `prisma db push` or `prisma db execute --file <sql> --config prisma/admin/prisma.config.ts`; **NEVER `prisma migrate dev/deploy`** — the admin DB is db-push-managed and migrate forces a destructive reset). **MAIN/prod game DB = read-only**, and do **not** build/propose features needing a MAIN schema change.

**7. Verification for UI:** the build gate is not enough — render it. Mint an `admin_session` JWT (sign with `SESSION_SECRET` per `src/lib/session.ts`, read one active admin from the ADMIN DB read-only) and drive Playwright. The **local game DB is stale** (missing tables → live admin pages throw locally), so render via **dev-only fixtures** (`src/app/responsive-fixture/*`) for pages that don't render. Reusable harness: `e2e/responsive/*` + `playwright.responsive.config.ts`.

**8. Honest reporting:** statuses are `DONE` / `PARTIAL` / `PROPOSED` / `BLOCKED`. Never fake a diff or a green gate. Flag omissions proactively.

**9. Always-on conventions:** house-POV colors (user gain = rose, house gain = emerald, neutral = blue), modern-page pattern (`PageHero`+`KpiTile`+`SectionHeading`), active-timeframe-only loading, NO function props server→client, push after EVERY finished task (never batch).

---

## 📸 CURRENT STATE (HEAD `f0325b9`)

**Shipped this session:** full dashboard rework (panel boxes, today/24h, per-program Reward Costs, KPI chip bottom-align) · unified forecast hub · **`/insights/system-edge-plan` complete** (Packs&Battles edge @10.99% + Upgrader @10%, **net-edge-by-scenario** [tier-8 → 0.99% net], concrete real-data reward levers, localStorage presets, exact-% inputs, resilient aggregates) · `/users` search rebuild · Total Withdrawn tile · **Balance 2.0** on excluded-users (admin-DB table applied) · `/insights` hub (was 404) · creator changelog + fired-creator + artifact-anchored ex-creators · quick-win sweep (security gates, 2FA on XP, audit event types, a11y/motion-safe, mobile grids, forecast tabs) · **smoothness foundation** (scroll-to-top on nav, motion-safe Button, `PeriodChips`/`TabContainer` primitives in `@/components/ux`) · 21 shape-matched `loading.tsx` · **`/users/[id]` responsive fix + the Playwright rendered-detection harness** · `ONBOARDING.md`.

**🟡 IN-FLIGHT — FINISH THIS:** the **responsive sweep** (workflow `responsive-sweep-fanout`, id `wgt5atu6q`) — 4 fan-out agents (detail / lists / tx-money / analytics-forms-auth) each rendering pages at 320→1536, fixing overflow/overlap/crush, and folding in `PeriodChips`/`TabContainer`/`AnimatedNumber`, then a verify agent. **To finish:** on completion → clean the 4 worktrees, read the verify verdict (must be **zero gating offenders**), and if any remain, dispatch a targeted follow-up fix workflow. The app was mostly responsive already, so expect mostly-clean + the smoothness layer.

**📋 OPEN / NEXT:**
- Fold this session's **confirmed findings** into `ONBOARDING.md`: affiliate commission = % of wager → erodes edge 1:1 (tier-8 nets 0.99%); signup `$5.71` = a CASH `balance_reward_claim` avg (lifetime; ~$2.09 live), NOT welcome packs; there is **1** real onboarding reward pack (Daily Tier 1, EV $0.0064), not 3 (the "level" rewards point at a defunct `custom` pack, EV $0); the stale-local-DB note.
- **Admin-DB schema drift** (decision pending): `creator_deals.monthly_cashout_limit` + `weekly_cashout_limit` (1 value each) + `creator_deal_estimates` (17 rows) exist in prod admin DB but were dropped from `prisma/admin/schema.prisma` (`db push` refuses). Restore in schema, or archive+drop.
- **View Transitions** route cross-fade = **deferred**: stable React 19.1 doesn't expose it; enabling needs the experimental React channel (forbidden dep swap). Revisit only if React is upgraded.
- **Hosted share link** (`ShareOnboardingGuide`) returned `undefined` (tool bug) — `ONBOARDING.md` is committed to `main` as the durable copy; retry the hosted link later.

---

## 🛠️ FAILED / BLOCKED / NEEDS-FIXING WORKSTREAMS (pick these up)

### 🔴 Blocked — needs the OWNER's decision
- **Bulk select/delete on `/gift-cards` + `/vouchers`** (audit item "H"). BLOCKED: both tables live in the **MAIN/prod DB**, so bulk-delete is a forbidden MAIN write. Nothing shipped. Owner must choose: **H1** allow the MAIN write as a one-off (promo-codes already does it), **H2** gift-cards-only admin-DB bulk-*cancel* (no MAIN write; vouchers has no admin-DB equivalent), or **H3** drop it. → Ask, then act. Reference pattern: `/promo-codes` (`actions.ts` `deletePromoCodesBulk` + data-table `BulkActionsBar` + selection-context + quick-select).

### 🟠 Tool failure
- **`ShareOnboardingGuide` returns `undefined`** (link + short_code both undefined; *"undefined is not an object (evaluating 'H.length')"*). The hosted "open in Claude Code" onboarding link could NOT be created. Workaround in place: `ONBOARDING.md` is committed to `main`. → Retry the hosted link when the tool is fixed.

### 🟡 Agent / workflow failures (self-recovered — note the patterns)
- **Workflow `script` parse errors (×2):** a backtick around `DATABASE_URL` and a `\\'` quote-escape inside workflow prompt STRINGS broke parsing. Both relaunched clean. **Lesson: NO inner backticks and NO `\'`/`\\'` inside a workflow `script` string — use plain text + `' + REPO + '` concatenation.**
- **Reward-data discovery (`w2p6fvax2`):** one parallel discovery agent (deposit/race/raffle) **completed without calling StructuredOutput** → that slice of the spec was missing. Recovered: the build agent re-derived it. → Expect occasional StructuredOutput no-shows in fan-outs; `.filter(Boolean)` + let the downstream step re-derive.

### 🟡 Verify-agent unreliability (do NOT trust a bare "not found")
- **False negative:** the Total-Withdrawn verify said the tile "doesn't exist" when it was present — it read a **stale tree**. Caught via `git show`. → Verify agents MUST `git fetch && checkout the exact SHA` first; cross-check any negative against `git show <sha>`.
- **Commit-message overclaim:** the smoothness-foundation commit claimed a "Spinner 12→14" tweak that was never made (`dashboard-period-selector.tsx` unchanged). Code is fine; the message overstated. → If you touch that file, the spinner-size bump is still a TODO if wanted.

### ⚪ Standing VERIFICATION GAP (affects ~everything shipped this session)
- **No live authenticated browser** (Chrome extension offline) + **stale local game DB** (missing tables → live admin pages throw locally). So nearly everything is **build-verified + render-checked via fixtures / minted session**, NOT clicked-through in a real logged-in browser. → A human (or a connected Chrome) should do a real logged-in pass of the high-traffic surfaces; or connect Chrome so the harness drives the real routes directly.

### 🔵 Deferred (not broken — revisit on the right conditions)
- **Route View-Transitions cross-fade:** stable React 19.1 does not expose it; enabling needs the experimental React channel (forbidden dep swap). `PeriodChips`/`TabContainer` are built; only the global cross-fade is deferred. Revisit if React is upgraded.
- **Backend-only reward settings:** daily-pack 30-day XP-unlock %, deposit match%/min-gate/wager-req, race entry threshold, raffle ticket-earn rate, rain wager-req — live in the GAME backend, not the admin schema, so the planner models them as cost-effect controls (display-only where truly unreadable). → Wire to real values only if they become readable / the owner provides them.

### 🟣 Unresolved data issues
- **Admin-DB schema drift:** `creator_deals.monthly_cashout_limit` + `weekly_cashout_limit` (1 value each) + `creator_deal_estimates` (17 rows) exist in prod admin DB but were dropped from `prisma/admin/schema.prisma` (`db push` refuses on data-loss). → Decide: restore in schema (then `db push` is clean) or archive-then-drop. Do NOT `--accept-data-loss` without that call.
- **Dangling locked worktree dirs:** a few `.claude/worktrees/*` dirs failed to delete (a build held `next-swc.win32-x64-msvc.node`). Un-git-tracked (pruned) but may still be on disk. → Sweep once locks release (junction-safe: check `LinkType` before recurse).

### 🟢 In-flight — FINISH IT
- **Responsive sweep** (`wgt5atu6q`, 4 fan-out agents + verify). → On completion: clean the 4 worktrees, confirm the verify reports **zero gating offenders** across 320→1536, and dispatch a targeted follow-up for any remaining. Harness: `e2e/responsive/*` + `playwright.responsive.config.ts` (`RESPONSIVE_EXPECT_CLEAN=1` after fixes).

---

## ⚠️ GOTCHAS (condensed — full list in ONBOARDING.md §7)
- **Stale local game DB** → live admin pages throw locally → render via fixtures.
- **React #130**: every nav `icon` string must be in the `ICONS` map in `src/components/app-sidebar.tsx`.
- **PowerShell UTF-8 BOM** breaks `.sql` files for Postgres — write SQL via Bash/`printf`.
- **Stale `.next`** can fail tsc (references deleted routes) — clear it before re-gating.
- **`gift_cards` + `vouchers` live in MAIN DB** (not admin) — bulk-delete on them = a MAIN write = forbidden.

## 🧰 Key references
`ONBOARDING.md` (knowledge + key-files table) · `CLAUDE.md` (binding rules) · `e2e/responsive/*` (responsive harness; run `npx playwright test --config=playwright.responsive.config.ts`, add `RESPONSIVE_EXPECT_CLEAN=1` after fixes) · deploy: `main` = Vercel prod (`pokewin-admin.vercel.app`).
