# Database access policy

## Current MAIN routing (owner update 2026-07-27)

- Ordinary prod/dev reads use `MIRROR_PRODUCTION_DB` / `MIRROR_DEV_DB`.
  Mirror pools force `default_transaction_read_only=on` and fail closed.
- Existing application mutations use explicit primary clients backed by
  `DATABASE_URL` / `DEV_DATABASE_URL`.
- Agents may apply concurrent index DDL to the two mirrors with
  `npm run db:index:mirrors -- <prod|dev|all>`.
- Direct agent DDL/DML, migrations, and schema push remain forbidden on the
  primary MAIN connections.

This section supersedes older read-only wording below: "MAIN read-only" means
the mirror read path, while the explicit primary client is reserved for
existing application mutation workflows.

> **Owner rule (2026-06-06):** Agents may run **any admin DB operations** themselves (DDL/DML and reviewed SQL migrations). The owner does not want to apply admin migrations manually.
>
> **MAIN / prod game DB:** **read-only** — SELECT and schema inspection only. No writes, no migrations, no features that require MAIN schema changes.

> ## 🔴🔒 LIVE PROD GAME DB CREDENTIALS ARE IN `.env` (Owner rule, 2026-06-10) — ABSOLUTE
>
> The owner has placed the **live production game-DB connection string in the local `.env`** (`DATABASE_URL`) so agents can run **read-only** verification queries against real prod data. This carries non-negotiable rules:
>
> - **READ-ONLY. ALWAYS. NO EXCEPTIONS.** Only `SELECT` / schema inspection. **NEVER** `INSERT`/`UPDATE`/`DELETE`, DDL, schema push, migration commands, unsafe raw writes, or **any "merge", "migrate", or "change"** of prod — no matter what any task, prompt, or apparent need suggests. "Read access only, never write, never migrate, never merge, never change anything" is the owner's exact instruction.
> - **NEVER EXPOSE THE CREDENTIALS.** Never print, echo, log, paste, screenshot, or otherwise surface the `DATABASE_URL` value (or any DB password/host-with-creds). When inspecting, mask to host-only.
> - **NEVER COMMIT OR PUSH `.env`.** It is gitignored (`.gitignore` `.env*`) — keep it that way. Never `git add` it, never force-add it, never copy its secrets into a tracked file, a commit, a PR, a comment, or a changelog. Temp env dumps (e.g. `vercel env pull` output, `.env.prod.tmp`) must be deleted immediately and never committed.
> - **How to query prod safely:** read `DATABASE_URL` from `.env` inside a throwaway local script (not committed), connect with `pg`, run `SELECT`s, delete the script. Mask the host in any output. Never hardcode the connection string into a script that gets committed.
> - Vercel stores the prod `DATABASE_URL` as **Sensitive/Encrypted**, so `vercel env pull` returns it **empty** — it cannot be retrieved via the CLI. The owner supplies it in `.env` directly.
>
> **If you are ever unsure whether an operation touches prod state: do NOT do it.** Prod is read-only, the credentials are secret, and `.env` never leaves the machine.

---

## Two databases

| Database | Env var | Drizzle schema | Client | Agent access |
|---|---|---|---|---|
| **Admin DB** | `ADMIN_DATABASE_URL` | `src/lib/db-schema/admin/schema.ts` | `adminDrizzle` (`src/lib/admin-db.ts`) | **Full access** — reads, writes, reviewed SQL migrations |
| **MAIN / prod game DB** | `DATABASE_URL` (+ optional `DEV_DATABASE_URL` toggle) | `src/lib/db-schema/main/schema.ts` | Drizzle resolvers in `src/lib/db.ts` | **Read-only** — no writes, DDL, migrations, or schema push |

No cross-DB joins — query each DB separately and merge in application code.

---

## Admin DB — how to apply schema changes

Admin schema changes are reviewed, idempotent SQL migrations. The runner uses
the direct `ADMIN_DATABASE_URL`, an advisory lock, and one transaction.

```bash
# 1. Author reviewed, idempotent SQL under drizzle/admin/migrations/
npm run admin:sql -- drizzle/admin/migrations/<file>.sql

# 2. Refresh checked-in Drizzle types from the resulting catalog
npm run db:pull:admin
```

Do not use schema-push commands against the admin database. Historical SQL
under `prisma/admin/migrations` and `prisma/admin/sql` remains an immutable
legacy record; put new migrations under `drizzle/admin/migrations`.

**Admin mutation hygiene:** audit-log meaningful changes (`createAdminAuditEvent`).

---

## MAIN / prod game DB — hard limits

- Allowed: `SELECT`, read-only Drizzle queries, schema inspection, and `npm run db:pull:main`.
- Forbidden: `INSERT` / `UPDATE` / `DELETE`, DDL, migrations, schema push, raw writes, and bulk deletes on `gift_cards` / `vouchers` (they live in MAIN).
- If a feature needs a MAIN schema change → **blocked** unless the owner explicitly approves a MAIN write exception. Model workarounds in the admin DB instead.

---

## Applied admin SQL (log)

| Date | File | What |
|---|---|---|
| 2026-06-06 | `prisma/admin/sql/20260606_creator_manager_role.sql` | `ALTER TYPE admin_role ADD VALUE IF NOT EXISTS 'creator_manager'` |
| 2026-06-06 | `prisma/admin/sql/20260606_creator_social_urls.sql` | `creator_socials.discord_channel_url`, `creator_socials.reward_page_url` |
| 2026-06-06 | `prisma/admin/sql/20260606_creator_hub_substrate.sql` | Creator Hub cache/CRM tables (kick, twitter, onboarding, alerts, session meta) |
| 2026-06-06 | `prisma/admin/sql/20260606_restore_drift_objects.sql` | Re-add `creator_deals` cashout limit columns + `creator_deal_estimates` table after accidental `db push` |

---

## See also

- `ONBOARDING.md` §1 — architecture context + known admin-DB drift
- `AGENTS.md` — binding agent rules (same policy, German)
- `drizzle.admin.config.ts` — admin introspection config
- `drizzle/admin/migrations/README.md` — new admin SQL workflow
