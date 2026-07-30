---
name: race-leaderboard-live-source
description: "How official race (daily/weekly/monthly) leaderboard standings are sourced, incl. the live-computation for a running monthly race and the timestamp-without-tz driver gotcha"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 4ff5adbd-aa17-4ed9-a1de-2497b489c3e8
---

Official race leaderboards (`/rewards?tab=leaderboards`) source of truth:

- **Finalized/ended periods** → `race_leaderboard_snapshots` (one row per user per period_start; `position` 1..N assigned at period END by wagered desc). Daily/weekly ALSO get **live** snapshot rows while running (position 0, live-ranked by wagered). **Monthly does NOT** — a monthly race has ZERO snapshot rows until it ends (verified 2026-07-15: active monthly had 0 snapshot rows, active weekly had 153).
- **Running monthly race (the live gap)** → computed live in `getLiveRaceLeaderboard` (`src/lib/queries/races.ts`, shipped 2026-07-15, commit 3276bd63): `SUM(game_sessions.bet_amount) WHERE race_eligible = true` over the race window `[starts_at, ends_at)`, grouped by user, ranked by wager. `getRaceLeaderboard` falls back to it when a period has 0 snapshots AND is the active race_period.

Validated read-only vs prod: reconstructing the last FINALIZED monthly race this way reproduced every snapshot's **position AND wagered_usd cent-exact** (top-15). Per-game leaderboard weights (`leaderboard-wager-weights` backend API: packs/battles/upgrader bps) are **1× today**, so raw `bet_amount` == the weighted leaderboard contribution. If non-1× weights are ever set, the live view drifts for wagers after the change (weights are frozen per-wager at bet time; there is no weighted column on `game_sessions`). Index: `idx_game_sessions_created_at_user_bet` (created_at, user_id, bet_amount) — EXPLAIN shows Bitmap Index Scan ~37ms over a month.

**CRITICAL timezone gotcha:** `game_sessions.created_at` AND `race_periods.starts_at`/`ends_at` are all `timestamp without time zone`, stored on the **same UTC-naive clock**. The `pg` driver (node-postgres) parses that column type as **LOCAL** time → round-tripping a bound through a JS Date shifts the window by the machine's offset (hours off, caught during validation — kartos $144k vs true $262k). Compare **naive-to-naive**: read bounds DB-side as strings (`to_char(starts_at,'YYYY-MM-DD HH24:MI:SS')`) and filter `created_at >= $s::timestamp AND created_at < $e::timestamp`. Do NOT use `AT TIME ZONE` on the column (breaks the index) and do NOT round-trip via `Date`. Session TZ is GMT. Related: [[pokewin-incident-pool-stampede]].
