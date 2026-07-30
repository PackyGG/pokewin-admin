---
name: pokewin-incident-pool-stampede
description: pokewin-admin whole-app crash/timeout root cause = thundering-herd on the MAIN max:3 Postgres pool triggered by ClickHouse degrade cascade
metadata: 
  node_type: memory
  type: project
  originSessionId: 354eaae5-3ab4-42d0-a0fc-5aa1c19bf1fa
---

The recurring "whole webapp crashes/times out" incident in pokewin-admin is ONE root cause, not many: a **thundering-herd on the MAIN game-DB Postgres pool** (`src/lib/db.ts`, `max:3` per warm instance, shared with the live game backend under the 100-conn cap).

**Chain:** ClickHouse (ClickHouse Cloud) briefly cold-starts/blips → `resolveAdminRead` gracefully degrades EVERY cutover surface (~40 in `CUTOVER_DEFAULT_CLICKHOUSE`) to its heavy Postgres aggregate AT ONCE → the max:3 pool exhausts → Prisma throws the constant-message pool-acquire timeout (P2024) → identical Next error digest on every page. `safeQuery`-wrapped reads degrade to tiles; UNWRAPPED reads hard-crash the route (that was the `digest 2596547046` on `/users/[id]` + `/insights/real-numbers`; the shared throw was actually `getExcludedUserIds()` failing CLOSED on a cold admin-DB blip).

**Fixes shipped (2026-07-01):** (1) `db.ts` fail-fast on P2024 (stop retrying pool-acquire timeouts — retry amplified the stampede); (2) `/api/cron/warm` warms the heavy shared caches, not just `SELECT 1`; (3) `src/lib/cache/single-flight.ts` collapses concurrent cold cache-misses; (4) per-process CH circuit-breaker in `resolve-read.ts` + CH per-query timeout lowered to ~8s (below the 15s safeQuery budget); (5) `getExcludedUserIds()` now fails OPEN (returns `[]`).

**The TRUE fix is owner-side infra:** set a pooled `DATABASE_URL_POOLED` (PgBouncer/Supavisor) on Vercel — `db.ts` already prefers it as a drop-in. Until then the max:3 ceiling remains the hard limit. See [[composed-main-build-verify]].
