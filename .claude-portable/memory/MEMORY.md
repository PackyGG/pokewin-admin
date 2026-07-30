# Memory Index

- [antifraud-monitor deploy](antifraud-monitor-deploy.md) — deploys ONLY via `railway up` from repo root (service pinned to /services/antifraud-monitor); git push alone changes nothing in prod
- [Fiat post-auth identity checks](fiat-post-auth-identity-checks.md) — planned card/email/IP/device drift-vs-first-deposit → KYC+lock; full spec + owner decisions, deferred behind concurrent fiat-eligibility work

- [Marketing subdomain = Creator Hub](marketing-subdomain-creator-hub.md) — segment host, clean URLs, flat redesign shipped 2026-07-29; new-page rules + hub primitives
- [Concurrent Codex sessions](concurrent-codex-sessions.md) — owner runs parallel Codex agents that push to main from the main checkout; never assume it's idle, work in isolated worktrees
- [cwd resets between turns](cwd-resets-between-turns.md) — destructive git only with explicit absolute cd in the same command; main checkout is shared territory, never hard-reset it

- [Mirror DB server facts](mirror-db-server-facts.md) — fraud box: fraud_app connlimit 30, logical replication (no lag), untuned PG defaults caused 98GB temp spill; session work_mem fix shipped; owner must tune shared_buffers via Coolify

- [Race leaderboard live source](race-leaderboard-live-source.md) — running monthly race has 0 snapshots → live SUM(race_eligible game_sessions.bet_amount) over window; validated cent-exact; timestamp-without-tz naive-compare gotcha
- [Proactive learning via agents](proactive-learning-agents.md) — user permits spawning agents/workflows freely to learn deeper, no need to ask
- [Pack edge model](pack-edge-model.md) — full engine: edge = 1−EV/price, per-pack curve 10.99→11.50%, relative bands, shapeWeights solver constants (verified 2026-07-02)
- [Pack Studio current state](pack-studio-current-state.md) — Retune V2 workspace shipped 2026-07-03 (one-brain planPackTune, guidance engine, fleet 36/41 clean); access model, gating, open items
- [Pack engine harness](pack-engine-harness-red.md) — GREEN 13/13 after the 2026-07-24 re-pin; live hazard left behind: TAGGED_SNAP_NODE_CAP tuned for 42 rungs, grid is now 65
- [Pack fleet sweep 2026-07](pack-fleet-sweep-2026-07.md) — 183 packs replayed: 0 stuck/throws/law breaches; how to rebuild the harness + the 2 checks that false-positive (write vs solver tag tol, cheapest-winner sink exemption)
- [Competitor pack system](competitor-pack-system.md) — 4-site laws (~10% edge, ~20% win-rate, CV risk); raw corpus lost (other PC), only rain.gg JSONs in Downloads survive
- [Owner-lens verification](owner-lens-verification.md) — STANDING RULE: outputs get business-judgment review + executable plan-quality gates; one bad output = sweep the whole class; owner is never the QA
- [Build→push preference](workflow-build-push-preference.md) — skip the verify phase, gates are enough, build+push fast, no headless render; browser-verify only if asked
- [Verify agent push before done](verify-agent-push-before-done.md) — confirm origin/main advanced + check diff before relaying a build agent's "done"
- [Composed-main build verify](composed-main-build-verify.md) — after parallel worktree pushes, run ONE final build on composed main; per-agent builds miss cross-agent breakage (dead-export vs new-consumer race broke prod once)
- [Fetch before audit](fetch-before-audit.md) — local main runs tens of commits behind origin; always fetch + diff vs origin/main before auditing or fixing (a 7.4M-token audit once ran on a 29-commit-stale tree)
- [Incident: pool stampede](pokewin-incident-pool-stampede.md) — whole-app crash/timeout = thundering-herd on MAIN max:3 pool via ClickHouse degrade cascade; true fix = owner sets DATABASE_URL_POOLED
- [Hide withdrawals = excluded_users](hide-withdrawals-excluded-users.md) — "hide all withdrawal info for user X (same as kartos)" = single admin-DB insert into excluded_users (full blacklist, no code change); no withdrawal-only flag exists
- [Creator-hub deal-cost model](creator-hub-deal-cost-model.md) — profitability dealCost = cap + sponsored-weighted LB + tips, NO fill leg; Active was already right, Past mirrors it; don't re-add fill or full-prize LB
- [Grailed design tokens](grailed-design-tokens.md) — real Grailed admin tokens (Chakra Petch font, indigo #1A1A29 ramp, cyan #65E3FF, solid #2E2E48 borders, 8px) for the grailed theme; v1 was a wrong-hue recolor
- [App flat design standard](app-flat-design-standard.md) — whole admin swept to flat neutral tiles (2026-07-12); don't reintroduce colored-fill/gradient/glow tiles; accent on icon+number; heroes/charts keep glow; House-POV money text + badges stay colored
- [Repo scope boundary](feedback_repo_scope_boundary.md) — pokewin-admin only; backend/frontend siblings read-only-research unless authorized; when authorized, PR into `dev` (not main), never direct push
- [Branch naming convention](branch-naming-convention.md) — PackyGG repos: name new branches motha/<category>/<slug> (owner identifier first), e.g. motha/design/toast-design-rework
- [No new API returns](no-new-api-response-returns.md) — owner rule: never add new data/fields to any backend endpoint response; route internal data through metadata JSONB (schema-stripped) + direct DB reads, never the API
- [Crypto fee model + tracking](crypto-fee-model-and-tracking.md) — hidden exchange-rate spread (deposit price×(1−f), withdrawal ×(1+f)); live on all 11 coins; actual profit tracked via ledger metadata.crypto_fee (backend PR #445)
- [Geo-block enforcement](geo-block-enforcement.md) — whole-site country block lives only in frontend proxy.ts middleware (Next16 proxy, DOES run); real trap = dual prod/dev game DBs (admin writes one, dev site reads DEV_DATABASE_URL) + 1-day cookie + 1hr backend Redis cache; middleware fetch SUCCEEDS (CF-bypass #739 was a mis-diagnosis, not the fix); caching PR #737
- [Affiliate code binding: 7d + 30min](affiliate-code-binding-7-days.md) — two clocks: 7-day attribution lock (can't switch codes, AFFILIATE_CODE_LOCKED) + separate 30-min deposit-bonus window; admin assign sets null = no lock
- [Deposit bonus live config](deposit-bonus-live-config.md) — 5% only inside the 30-min window, then capped $20/6h (live=20, code said 25); only 37% of deposit volume is in-window → real cost ~1% of deposits, not 5%
- [Personal notification templates](personal-notification-frontend-templates.md) — frontend renders only 3 notification types; unknown `type` = "Notification / words" fallback, payload dropped, personal rows never linkable
- [Promo code user binding](promo-code-user-binding.md) — metadata.bound_user_id restricts a code to one account (backend#462); reward codes are HMAC-derived so retries reuse them, never re-mint
