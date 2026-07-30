---
name: mirror-db-server-facts
description: "Production MAIN mirror (fraud box) server facts — fraud_app connlimit 30, logical replication fraud_sub, untuned PG defaults, session-level work_mem fix shipped 2026-07-28"
metadata: 
  node_type: memory
  type: project
  originSessionId: 231a2d36-edbd-4645-9735-8b0025d892ab
  modified: 2026-07-28T20:39:35.064Z
---

The production MAIN read mirror is a single PostgreSQL 18 (Alpine/Coolify) server, database `postgres` (~6.6GB), shared with the antifraud source reader (`packy-antifraud-source-reader`). Verified 2026-07-28:

- Role `fraud_app`: **CONNECTION LIMIT 30** (not the server's max_connections=100), non-superuser, no ALTER SYSTEM, role-level `statement_timeout=30s`. The only superuser is `postgres` (no credential available to agents).
- Data flows in via **logical replication** (`pg_stat_subscription` sub `fraud_sub`) — `pg_is_in_recovery()` is false; lag was zero (byte-identical max timestamps vs primary). "Old data" symptoms = stale last-known-good app caches after query timeouts, NOT replication lag.
- Server ran untuned defaults: shared_buffers 128MB, work_mem 4MB, random_page_cost 4 → 61% buffer hit rate, 98GB temp-file spill. Fix shipped (commit `513f30f3`): mirror pool options add `-c work_mem=32MB -c random_page_cost=1.1` (both USERSET; verified applying as fraud_app).
- pg_stat_statements extension exists but is NOT in shared_preload_libraries (unusable).

**Open owner actions (need `postgres` superuser / Coolify):** raise shared_buffers to ~25% host RAM (restart), effective_cache_size ~70% RAM, optionally `ALTER ROLE fraud_app CONNECTION LIMIT 60`, preload pg_stat_statements.

Related: [[pokewin-incident-pool-stampede]]
