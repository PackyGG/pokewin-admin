# Database access policy

> **Owner rule (2026-06-06):** Agents may run **any admin DB operations** themselves (DDL/DML, `prisma db push`, `prisma db execute`). The owner does not want to apply admin migrations manually.
>
> **MAIN / prod game DB:** **read-only** — SELECT and schema inspection only. No writes, no migrations, no features that require MAIN schema changes.

---

## Two databases

| Database | Env var | Prisma schema | Client | Agent access |
|---|---|---|---|---|
| **Admin DB** | `ADMIN_DATABASE_URL` | `prisma/admin/schema.prisma` | `adminDb` (`src/lib/admin-db.ts`) | **Full access** — reads, writes, DDL, `db push`, `db execute` |
| **MAIN / prod game DB** | `DATABASE_URL` (+ optional `DEV_DATABASE_URL` toggle) | `prisma/schema.prisma` | `getDb()` / `db` (`src/lib/db.ts`) | **Read-only** — no writes, no DDL, no `migrate` / `db push` |

No cross-DB joins — query each DB separately and merge in application code.

---

## Admin DB — how to apply schema changes

The prod admin database is **`db push` / `db execute`-managed**, not baselined on `prisma migrate deploy`. **Do not run** `prisma migrate dev` or `prisma migrate deploy` against admin — it can demand a destructive reset.

**Preferred paths:**

```bash
# Additive SQL (enums, columns, indexes) — idempotent IF NOT EXISTS
npx prisma db execute --config prisma/admin/prisma.config.ts --file prisma/admin/sql/<file>.sql

# Schema sync from prisma/admin/schema.prisma (refuses on data loss)
npx prisma db push --schema prisma/admin/schema.prisma --config prisma/admin/prisma.config.ts

# NEVER pass --accept-data-loss on admin — prod has drift columns/tables not in schema.prisma

# Regenerate client after schema edits
npx prisma generate --schema prisma/admin/schema.prisma --config prisma/admin/prisma.config.ts
```

Put new SQL under `prisma/admin/sql/` with a dated filename. Keep `prisma/admin/schema.prisma` in sync for typed `adminDb.*` access.

**Admin mutation hygiene:** audit-log meaningful changes (`createAdminAuditEvent`).

---

## MAIN / prod game DB — hard limits

- Allowed: `SELECT`, read-only Prisma queries, schema inspection for debugging.
- Forbidden: `INSERT` / `UPDATE` / `DELETE`, DDL, `prisma migrate`, `prisma db push`, `$executeRaw` with writes, bulk deletes on `gift_cards` / `vouchers` (they live in MAIN).
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
- `prisma/admin/prisma.config.ts` — admin datasource config
