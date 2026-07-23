-- Chat Raffle — the whole system lives in the ADMIN DB.
--
-- The MAIN (prod game) DB is READ-ONLY for this feature: tickets are derived
-- live from `chat_messages` (already covered by the partial index
-- idx_chat_messages_created_at_user_id, see prisma/recommended-indexes.sql #33)
-- and the ONLY main-DB write is the existing balance-adjustment path when an
-- operator pays a winner. No prod schema change, no prod code change.
--
-- Four tables:
--   chat_raffle_rounds       one row per raffle round + its scoring config
--   chat_raffle_prizes       the prize ladder of a round + who won + payout link
--   chat_raffle_entries      FROZEN standings snapshot written at draw time
--   chat_raffle_adjustments  manual per-user point corrections inside a round
--
-- Purely ADDITIVE and idempotent. Written as raw SQL (this repo's
-- prisma/admin/sql convention) rather than `prisma migrate dev` / `db push`:
-- the CLI does not see this schema's migration history from the default path
-- (so `migrate dev` could offer to RESET the admin DB), and several perf
-- indexes exist in the DB but are deliberately UNMODELED in schema.prisma, so
-- a `db push` diff would try to DROP them.

-- ─── Rounds ──────────────────────────────────────────────────────────────
-- `status` is a lifecycle flag only: 'open' | 'drawn' | 'cancelled'. The
-- scheduled / running / ready-to-draw distinction is DERIVED from
-- (starts_at, ends_at, now()) at read time — there is no cron in this admin,
-- so nothing needs to flip a status on a timer.
--
-- Every scoring knob lives ON THE ROUND (not in a global settings row) so a
-- round is fully self-describing forever: changing the weights next month can
-- never retroactively rewrite how a past round was scored. The "new round"
-- dialog pre-fills from the most recent round, which gives config continuity
-- without a second table.
CREATE TABLE IF NOT EXISTS "chat_raffle_rounds" (
  "id"                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"                      TEXT           NOT NULL,
  "status"                    TEXT           NOT NULL DEFAULT 'open',
  "starts_at"                 TIMESTAMPTZ(6) NOT NULL,
  "ends_at"                   TIMESTAMPTZ(6) NOT NULL,

  -- Scoring weights.
  "points_per_message"        INTEGER        NOT NULL DEFAULT 1,
  "min_message_chars"         INTEGER        NOT NULL DEFAULT 3,
  "long_message_chars"        INTEGER        NOT NULL DEFAULT 40,
  "long_message_bonus_points" INTEGER        NOT NULL DEFAULT 1,

  -- Anti-farm rate cap: at most N counted messages per bucket per user.
  "bucket_minutes"            INTEGER        NOT NULL DEFAULT 10,
  "max_messages_per_bucket"   INTEGER        NOT NULL DEFAULT 10,
  -- Count an identical (case-insensitive, trimmed) message once per bucket.
  "dedupe_identical"          BOOLEAN        NOT NULL DEFAULT true,

  -- Per-user ceiling over the whole round (NULL = uncapped) and the floor a
  -- user must reach to be in the draw at all.
  "max_points_per_user"       INTEGER,
  "min_points_to_enter"       INTEGER        NOT NULL DEFAULT 1,

  -- Eligibility. exclude_staff drops admin/support/creator (the canonical
  -- CUSTOMER_EXCLUDED_ROLES); exclude_blacklisted drops the excluded_users
  -- blacklist; exclude_muted drops users with an active chat mute.
  "exclude_staff"             BOOLEAN        NOT NULL DEFAULT true,
  "exclude_blacklisted"       BOOLEAN        NOT NULL DEFAULT true,
  "exclude_muted"             BOOLEAN        NOT NULL DEFAULT true,
  -- Can one user take more than one prize in the same round?
  "allow_repeat_winners"      BOOLEAN        NOT NULL DEFAULT false,

  -- Draw provenance. `draw_seed` + chat_raffle_entries make the draw fully
  -- reproducible: winner N = HMAC-SHA256(seed, "<round id>:<n>") mod tickets.
  "draw_seed"                 TEXT,
  "drawn_at"                  TIMESTAMPTZ(6),
  "drawn_by"                  UUID,
  "entrants_at_draw"          INTEGER,
  "tickets_at_draw"           INTEGER,

  "notes"                     TEXT,
  "created_by"                UUID,
  "created_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "chat_raffle_rounds_drawn_by_fkey"
    FOREIGN KEY ("drawn_by") REFERENCES "admin_users"("id") ON DELETE SET NULL,
  CONSTRAINT "chat_raffle_rounds_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "admin_users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "chat_raffle_rounds_status_idx"
  ON "chat_raffle_rounds" ("status");
CREATE INDEX IF NOT EXISTS "chat_raffle_rounds_ends_at_idx"
  ON "chat_raffle_rounds" ("ends_at" DESC);

-- ─── Prizes ──────────────────────────────────────────────────────────────
-- One row per payable place. The winner columns are NULL until the draw; the
-- payout columns stay NULL until an operator actually credits the balance
-- (the draw and the payment are deliberately separate steps).
--
-- `ledger_tx_id` is TEXT, not an FK — the main DB is a different Postgres
-- cluster, so this is a cross-reference only.
CREATE TABLE IF NOT EXISTS "chat_raffle_prizes" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "round_id"        UUID           NOT NULL,
  "position"        INTEGER        NOT NULL,
  "amount_usd"      NUMERIC(20,2)  NOT NULL,
  "label"           TEXT,
  -- packy.gg user.id (better-auth nanoid, text). Username captured at draw
  -- time so a later rename does not rewrite history.
  "winner_user_id"  TEXT,
  "winner_username" TEXT,
  "winner_tickets"  INTEGER,
  "winning_ticket"  BIGINT,
  "paid_at"         TIMESTAMPTZ(6),
  "paid_by"         UUID,
  "ledger_tx_id"    TEXT,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "chat_raffle_prizes_round_id_fkey"
    FOREIGN KEY ("round_id") REFERENCES "chat_raffle_rounds"("id") ON DELETE CASCADE,
  CONSTRAINT "chat_raffle_prizes_paid_by_fkey"
    FOREIGN KEY ("paid_by") REFERENCES "admin_users"("id") ON DELETE SET NULL,
  CONSTRAINT "chat_raffle_prizes_round_position_unique" UNIQUE ("round_id", "position")
);

CREATE INDEX IF NOT EXISTS "chat_raffle_prizes_round_idx"
  ON "chat_raffle_prizes" ("round_id");

-- ─── Entries (frozen draw snapshot) ──────────────────────────────────────
-- Written ONCE, at draw time, from the live standings. This is what makes a
-- past round auditable: the live query would re-score differently the moment
-- a moderator soft-deletes an old message, so the numbers the draw actually
-- ran on are persisted here instead of recomputed.
--
-- `ticket_start` is the entry's first ticket number in the cumulative range
-- (entries ordered by position) as the pool stood for the FIRST pick. When
-- repeat winners are disallowed each winner is then removed, so later picks
-- run against a smaller pool — a replay still reproduces them exactly (the
-- removal order is the recorded winner order), but by re-deriving the ranges
-- rather than reading `ticket_start` directly. See src/lib/chat-raffle/draw.ts.
CREATE TABLE IF NOT EXISTS "chat_raffle_entries" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "round_id"          UUID           NOT NULL,
  "user_id"           TEXT           NOT NULL,
  "username"          TEXT,
  "message_count"     INTEGER        NOT NULL DEFAULT 0,
  "base_points"       INTEGER        NOT NULL DEFAULT 0,
  "adjustment_points" INTEGER        NOT NULL DEFAULT 0,
  "tickets"           INTEGER        NOT NULL DEFAULT 0,
  "ticket_start"      BIGINT         NOT NULL DEFAULT 0,
  "position"          INTEGER        NOT NULL DEFAULT 0,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "chat_raffle_entries_round_id_fkey"
    FOREIGN KEY ("round_id") REFERENCES "chat_raffle_rounds"("id") ON DELETE CASCADE,
  CONSTRAINT "chat_raffle_entries_round_user_unique" UNIQUE ("round_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "chat_raffle_entries_round_position_idx"
  ON "chat_raffle_entries" ("round_id", "position");

-- ─── Manual point adjustments ────────────────────────────────────────────
-- Operator-applied corrections inside a round (+points for a helpful player,
-- -points for someone gaming the counter). Additive rows, never edited in
-- place, so the correction history survives. They apply on TOP of the scored
-- base points and are folded into the ticket count before the draw.
CREATE TABLE IF NOT EXISTS "chat_raffle_adjustments" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "round_id"   UUID           NOT NULL,
  "user_id"    TEXT           NOT NULL,
  "points"     INTEGER        NOT NULL,
  "reason"     TEXT           NOT NULL,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "chat_raffle_adjustments_round_id_fkey"
    FOREIGN KEY ("round_id") REFERENCES "chat_raffle_rounds"("id") ON DELETE CASCADE,
  CONSTRAINT "chat_raffle_adjustments_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "admin_users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "chat_raffle_adjustments_round_idx"
  ON "chat_raffle_adjustments" ("round_id");
CREATE INDEX IF NOT EXISTS "chat_raffle_adjustments_round_user_idx"
  ON "chat_raffle_adjustments" ("round_id", "user_id");

-- ─── Permission-token rename: /top-chatters → /chat-raffle ───────────────
-- The page key moved with the route. Rewrite the token in place so any admin
-- who was explicitly granted the old page keeps access (admins/owners bypass
-- the check anyway). Idempotent: array_replace is a no-op once rewritten.
UPDATE "admin_users"
   SET "allowed_pages" = array_replace("allowed_pages", '/top-chatters', '/chat-raffle')
 WHERE '/top-chatters' = ANY("allowed_pages");

UPDATE "admin_users"
   SET "permission_grants" = array_replace("permission_grants", '/top-chatters', '/chat-raffle')
 WHERE '/top-chatters' = ANY("permission_grants");

UPDATE "admin_users"
   SET "permission_revokes" = array_replace("permission_revokes", '/top-chatters', '/chat-raffle')
 WHERE '/top-chatters' = ANY("permission_revokes");

UPDATE "admin_roles"
   SET "capabilities" = array_replace("capabilities", '/top-chatters', '/chat-raffle')
 WHERE '/top-chatters' = ANY("capabilities");
