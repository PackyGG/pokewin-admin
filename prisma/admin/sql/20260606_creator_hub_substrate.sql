-- Creator Hub substrate -- ADMIN-DB additive tables (2026-06-06)
-- Provisioned via `prisma db execute` (NOT migrate; admin DB is db-push/execute-managed
-- with a drifted migration history). Every statement is IF NOT EXISTS / idempotent.
-- The Prisma model blocks in prisma/admin/schema.prisma are mirrors for typed access.
-- Mirrors the runtime ensure-schema convention (changelog/ensure-schema.ts etc.).
-- ZERO touches to known-drift objects (creator_deals.monthly/weekly_cashout_limit,
-- creator_deal_estimates). Read paths must catch P2021/42P01 and degrade gracefully.

-- == 1. kick_profiles -- cached Kick channel profile (served from DB) ==
CREATE TABLE IF NOT EXISTS "kick_profiles" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "username"        TEXT NOT NULL,
  "kick_user_id"    TEXT,
  "display_name"    TEXT,
  "avatar_url"      TEXT,
  "bio"             TEXT,
  "follower_count"  INTEGER,
  "is_verified"     BOOLEAN,
  "is_live"         BOOLEAN NOT NULL DEFAULT false,
  "raw_json"        JSONB,
  "last_fetched_at" TIMESTAMPTZ(6),
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "kick_profiles_username_key" ON "kick_profiles" ("username");
CREATE INDEX IF NOT EXISTS "kick_profiles_last_fetched_at_idx" ON "kick_profiles" ("last_fetched_at");

-- == 2. kick_streams -- cached past/live Kick streams (VODs) ==
CREATE TABLE IF NOT EXISTS "kick_streams" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "username"         TEXT NOT NULL,
  "kick_stream_id"   TEXT NOT NULL,
  "title"            TEXT,
  "category"         TEXT,
  "thumbnail_url"    TEXT,
  "started_at"       TIMESTAMPTZ(6),
  "ended_at"         TIMESTAMPTZ(6),
  "duration_seconds" INTEGER,
  "vod_views"        INTEGER,
  "peak_viewers"     INTEGER,
  "vod_url"          TEXT,
  "raw_json"         JSONB,
  "last_fetched_at"  TIMESTAMPTZ(6),
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "kick_streams_username_stream_unique" ON "kick_streams" ("username", "kick_stream_id");
CREATE INDEX IF NOT EXISTS "kick_streams_username_started_idx" ON "kick_streams" ("username", "started_at" DESC);

-- == 3. twitter_profiles -- cached X/Twitter profile (served from DB) ==
CREATE TABLE IF NOT EXISTS "twitter_profiles" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "username"        TEXT NOT NULL,
  "twitter_user_id" TEXT,
  "display_name"    TEXT,
  "avatar_url"      TEXT,
  "bio"             TEXT,
  "follower_count"  INTEGER,
  "following_count" INTEGER,
  "tweet_count"     INTEGER,
  "is_verified"     BOOLEAN,
  "raw_json"        JSONB,
  "last_fetched_at" TIMESTAMPTZ(6),
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "twitter_profiles_username_key" ON "twitter_profiles" ("username");
CREATE INDEX IF NOT EXISTS "twitter_profiles_last_fetched_at_idx" ON "twitter_profiles" ("last_fetched_at");

-- == 4. tweets -- cached latest tweets (frequently re-fetched) ==
CREATE TABLE IF NOT EXISTS "tweets" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "username"        TEXT NOT NULL,
  "tweet_id"        TEXT NOT NULL,
  "text"            TEXT NOT NULL,
  "like_count"      INTEGER,
  "retweet_count"   INTEGER,
  "reply_count"     INTEGER,
  "view_count"      INTEGER,
  "mentions_us"     BOOLEAN NOT NULL DEFAULT false,
  "url"             TEXT,
  "posted_at"       TIMESTAMPTZ(6),
  "raw_json"        JSONB,
  "last_fetched_at" TIMESTAMPTZ(6),
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "tweets_username_tweet_unique" ON "tweets" ("username", "tweet_id");
CREATE INDEX IF NOT EXISTS "tweets_username_posted_idx" ON "tweets" ("username", "posted_at" DESC);
CREATE INDEX IF NOT EXISTS "tweets_username_mentions_posted_idx" ON "tweets" ("username", "mentions_us", "posted_at" DESC);

-- == 5. twitter_mentions -- brand-mention tracking (cross-handle log) ==
CREATE TABLE IF NOT EXISTS "twitter_mentions" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "username"        TEXT NOT NULL,
  "tweet_id"        TEXT NOT NULL,
  "text"            TEXT NOT NULL,
  "matched_keyword" TEXT,
  "url"             TEXT,
  "posted_at"       TIMESTAMPTZ(6),
  "last_fetched_at" TIMESTAMPTZ(6),
  "raw_json"        JSONB,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "twitter_mentions_tweet_unique" ON "twitter_mentions" ("tweet_id");
CREATE INDEX IF NOT EXISTS "twitter_mentions_posted_idx" ON "twitter_mentions" ("posted_at" DESC);
CREATE INDEX IF NOT EXISTS "twitter_mentions_username_posted_idx" ON "twitter_mentions" ("username", "posted_at" DESC);

-- == 6. creator_onboarding_checklist -- per-creator onboarding state ==
CREATE TABLE IF NOT EXISTS "creator_onboarding_checklist" (
  "id"                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "target_user_id"            TEXT NOT NULL,
  "lb_funds_collected"        BOOLEAN NOT NULL DEFAULT false,
  "lb_funds_collected_at"     TIMESTAMPTZ(6),
  "twitter_giveaway_done"     BOOLEAN NOT NULL DEFAULT false,
  "twitter_giveaway_url"      TEXT,
  "streaming_assets_provided" BOOLEAN NOT NULL DEFAULT false,
  "lb_prepaid_coin"           TEXT,
  "lb_prepaid_tx_url"         TEXT,
  "completed_at"              TIMESTAMPTZ(6),
  "updated_by"                UUID,
  "created_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "creator_onboarding_checklist_target_user_id_key" ON "creator_onboarding_checklist" ("target_user_id");
CREATE INDEX IF NOT EXISTS "creator_onboarding_checklist_completed_idx" ON "creator_onboarding_checklist" ("completed_at");

-- == 7. creator_crm -- account-owner / stage / CRM (contact log reuses admin_notes) ==
CREATE TABLE IF NOT EXISTS "creator_crm" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "target_user_id"   TEXT NOT NULL,
  "account_owner_id" UUID,
  "stage"            TEXT NOT NULL DEFAULT 'onboarding',
  "onboarded_by"     UUID,
  "onboarded_at"     TIMESTAMPTZ(6),
  "next_followup_at" TIMESTAMPTZ(6),
  "updated_by"       UUID,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "creator_crm_target_user_id_key" ON "creator_crm" ("target_user_id");
CREATE INDEX IF NOT EXISTS "creator_crm_account_owner_idx" ON "creator_crm" ("account_owner_id");
CREATE INDEX IF NOT EXISTS "creator_crm_stage_idx" ON "creator_crm" ("stage");

-- == 8. creator_alerts -- needs-attention center (read/dismiss state) ==
CREATE TABLE IF NOT EXISTS "creator_alerts" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "target_user_id" TEXT,
  "alert_type"     TEXT NOT NULL,
  "dedupe_key"     TEXT NOT NULL,
  "severity"       TEXT NOT NULL DEFAULT 'info',
  "metadata"       JSONB,
  "read_at"        TIMESTAMPTZ(6),
  "read_by"        UUID,
  "dismissed_at"   TIMESTAMPTZ(6),
  "dismissed_by"   UUID,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "creator_alerts_dedupe_key_key" ON "creator_alerts" ("dedupe_key");
CREATE INDEX IF NOT EXISTS "creator_alerts_active_idx" ON "creator_alerts" ("dismissed_at", "severity", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "creator_alerts_target_user_idx" ON "creator_alerts" ("target_user_id");

-- == 9. creator_session_meta -- Sessions-tab VOD/notes sidecar ==
CREATE TABLE IF NOT EXISTS "creator_session_meta" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id"     TEXT NOT NULL,
  "target_user_id" TEXT NOT NULL,
  "kick_vod_url"   TEXT,
  "notes"          TEXT,
  "updated_by"     UUID,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "creator_session_meta_session_id_key" ON "creator_session_meta" ("session_id");
CREATE INDEX IF NOT EXISTS "creator_session_meta_target_user_idx" ON "creator_session_meta" ("target_user_id");
