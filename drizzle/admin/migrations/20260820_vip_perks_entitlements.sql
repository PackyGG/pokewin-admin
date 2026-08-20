-- VIP membership (the durable Discord/channel link and CRM `vip` tag) is
-- deliberately separate from access to wager-gated perks.  This state lives
-- in Admin; MAIN remains read-only and is used only to measure wager.
CREATE TABLE IF NOT EXISTS "vip_perks_config" (
  "guild_id" text PRIMARY KEY NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "initial_wager_usd" numeric(20, 2) NOT NULL DEFAULT 0,
  "recurring_enabled" boolean NOT NULL DEFAULT false,
  "recurring_wager_usd" numeric(20, 2),
  "updated_by_admin_id" uuid REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vip_perks_config_guild_id_check"
    CHECK ("guild_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "vip_perks_config_initial_wager_check"
    CHECK ("initial_wager_usd" >= 0),
  CONSTRAINT "vip_perks_config_recurring_wager_check"
    CHECK ("recurring_wager_usd" IS NULL OR "recurring_wager_usd" > 0),
  CONSTRAINT "vip_perks_config_recurring_shape_check"
    CHECK (NOT "recurring_enabled" OR "recurring_wager_usd" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "vip_perk_entitlements" (
  "link_id" uuid PRIMARY KEY NOT NULL
    REFERENCES "discord_vip_channel_links"("id") ON DELETE CASCADE,
  "initial_window_started_at" timestamptz NOT NULL,
  "initial_unlocked_at" timestamptz,
  "last_status" text NOT NULL DEFAULT 'pending',
  "last_active" boolean NOT NULL DEFAULT false,
  "last_initial_wager_usd" numeric(20, 2) NOT NULL DEFAULT 0,
  "last_previous_cycle_wager_usd" numeric(20, 2) NOT NULL DEFAULT 0,
  "last_current_cycle_wager_usd" numeric(20, 2) NOT NULL DEFAULT 0,
  "last_evaluated_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vip_perk_entitlements_status_check"
    CHECK ("last_status" IN ('pending', 'active', 'expired', 'recurring_due', 'inactive')),
  CONSTRAINT "vip_perk_entitlements_wager_check"
    CHECK (
      "last_initial_wager_usd" >= 0
      AND "last_previous_cycle_wager_usd" >= 0
      AND "last_current_cycle_wager_usd" >= 0
    )
);

CREATE INDEX IF NOT EXISTS "vip_perk_entitlements_status_idx"
  ON "vip_perk_entitlements" ("last_active", "last_status", "updated_at" DESC);

CREATE TABLE IF NOT EXISTS "vip_perk_reset_operations" (
  "idempotency_key" uuid PRIMARY KEY NOT NULL,
  "link_id" uuid NOT NULL
    REFERENCES "discord_vip_channel_links"("id") ON DELETE CASCADE,
  "actor_admin_id" uuid REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "window_started_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Existing links receive the original link timestamp as their immutable first
-- qualification start. Re-linking or changing the channel never extends it.
INSERT INTO "vip_perk_entitlements" ("link_id", "initial_window_started_at")
SELECT "id", "created_at"
FROM "discord_vip_channel_links"
ON CONFLICT ("link_id") DO NOTHING;

-- Default fail-closed config. Staff must set a positive initial requirement
-- before enabling it.
INSERT INTO "vip_perks_config" ("guild_id")
VALUES ('1505650386894327919')
ON CONFLICT ("guild_id") DO NOTHING;

-- Existing trusted VIP-link consumers inherit the narrower entitlement-sync
-- capability without tying the migration to an environment-specific key.
UPDATE "api_keys"
SET "scopes" = array_append("scopes", 'discord:vips:perks')
WHERE "is_active" = true
  AND ('discord:vips:link' = ANY("scopes"))
  AND NOT ('discord:vips:perks' = ANY("scopes"));
