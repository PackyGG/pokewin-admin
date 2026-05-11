-- admin_giveaway_actions: admin-DB metadata for balance adjustments
-- tagged as "Giveaway" on the /users/[id] adjust-balance flow. Source
-- URL + cross-reference to the main-DB ledger row.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "admin_giveaway_actions" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "admin_user_id"  UUID         NOT NULL,
  "target_user_id" TEXT         NOT NULL,
  "amount_usd"     NUMERIC(20, 2) NOT NULL,
  "source_url"     TEXT         NOT NULL,
  "source_type"    TEXT         NOT NULL,
  "reason"         TEXT,
  "ledger_tx_id"   TEXT,
  "created_at"     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT "admin_giveaway_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_giveaway_actions_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id")
    REFERENCES "admin_users"("id")
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "admin_giveaway_actions_created_at_idx"
  ON "admin_giveaway_actions" ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "admin_giveaway_actions_target_user_id_idx"
  ON "admin_giveaway_actions" ("target_user_id");
