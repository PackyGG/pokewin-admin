# Database connection pooler — deployment checklist

The admin dashboard runs small per-instance PostgreSQL pools (`max: 3` for the
main game DB, `max: 5` for the admin DB) through Drizzle and `node-postgres`.
Under concurrent admin load across multiple serverless instances this can
approach the shared Postgres connection ceiling. A managed connection pooler
multiplexes many client connections onto a small server-side pool and is the
real fix.

## Why a pooled connection string

Both runtime clients (`src/lib/db.ts`, `src/lib/admin-db.ts`) use raw PostgreSQL
connection strings. A pooled endpoint (PgBouncer / Neon pooler / Supabase
pooler / Supavisor / RDS Proxy) is therefore a drop-in.

## What the code already does

`getClient()` / the admin adapter prefer a `*_POOLED` URL and fall back to the
direct URL, so **nothing changes until you set the pooled vars**:

```
main  runtime: DATABASE_URL_POOLED        ?? DATABASE_URL
admin runtime: ADMIN_DATABASE_URL_POOLED  ?? ADMIN_DATABASE_URL
```

The runtime connection is environment-driven. The MAIN game DB stays read-only
and is not migrated.

## Owner-side steps (vendor)

1. **Provision the pooler** in front of the existing Postgres:
   - Neon: enable the pooled endpoint (host `...-pooler...`).
   - Supabase: use the Supavisor pooled connection string (port 6543).
   - Self-hosted PgBouncer / RDS Proxy: point it at the primary; use
     **transaction** pooling mode.
2. **Get the pooled connection string** for each DB.
3. For **transaction-mode** poolers, append `?pgbouncer=true` to the pooled URL
   (disables prepared-statement assumptions). Session-mode poolers don't need it.
4. **Set Vercel env** (Production + Preview):
   - `DATABASE_URL_POOLED` = pooled main-DB URL.
   - `ADMIN_DATABASE_URL_POOLED` = pooled admin-DB URL.
   - **Leave** `DATABASE_URL` / `ADMIN_DATABASE_URL` pointing at the **direct**
     endpoints (direct stays the in-code fallback; schema tooling also uses the
     direct `ADMIN_DATABASE_URL`).
5. **Redeploy.** The runtime now routes through the pooler.

## Verify after deploy

- `GET /api/cron/warm` (with the `CRON_SECRET` bearer) should still report
  `postgres: "ok <Nms>"`.
- Watch the Postgres "active connections" metric — it should flatten near the
  pooler's server-side pool size instead of scaling with instance count.
- No pool timeout or `too many connections` errors under load.

## Rollback

Unset `DATABASE_URL_POOLED` / `ADMIN_DATABASE_URL_POOLED` (or clear them in
Vercel) and redeploy — the code falls straight back to the direct URLs.

## Pool sizing note

With a pooler in front, the per-instance `max` (3 main / 5 admin) can stay as-is
(it still bounds sockets per instance) or be raised, since the pooler now
multiplexes onto a small server-side pool. No urgent change required.
