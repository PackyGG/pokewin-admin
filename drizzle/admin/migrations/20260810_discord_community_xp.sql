CREATE TABLE IF NOT EXISTS discord_community_xp_profiles (
  discord_user_id text PRIMARY KEY,
  total_xp integer NOT NULL DEFAULT 0,
  discord_xp integer NOT NULL DEFAULT 0,
  site_chat_xp integer NOT NULL DEFAULT 0,
  counted_messages integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discord_community_xp_profiles_user_check
    CHECK (discord_user_id ~ '^[0-9]{17,20}$'),
  CONSTRAINT discord_community_xp_profiles_totals_check
    CHECK (total_xp >= 0 AND discord_xp >= 0 AND site_chat_xp >= 0
      AND total_xp = discord_xp + site_chat_xp AND counted_messages >= 0)
);

CREATE TABLE IF NOT EXISTS discord_community_xp_events (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  source_event_id text NOT NULL,
  discord_user_id text NOT NULL REFERENCES discord_community_xp_profiles(discord_user_id) ON DELETE CASCADE,
  channel_id text,
  content_hash text,
  occurred_at timestamptz NOT NULL,
  awarded_xp integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_event_id),
  CONSTRAINT discord_community_xp_events_source_check CHECK (source IN ('discord', 'site_chat')),
  CONSTRAINT discord_community_xp_events_award_check CHECK (awarded_xp BETWEEN 0 AND 15),
  CONSTRAINT discord_community_xp_events_reason_check
    CHECK (reason IN ('awarded', 'too_short', 'low_quality', 'cooldown', 'duplicate', 'daily_cap'))
);

CREATE INDEX IF NOT EXISTS discord_community_xp_events_user_time_idx
  ON discord_community_xp_events (discord_user_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS discord_community_xp_profiles_rank_idx
  ON discord_community_xp_profiles (total_xp DESC, discord_user_id);

CREATE TABLE IF NOT EXISTS discord_community_xp_cursors (
  source text PRIMARY KEY,
  last_occurred_at timestamptz NOT NULL,
  last_event_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discord_community_xp_cursors_source_check CHECK (source = 'site_chat')
);

CREATE TABLE IF NOT EXISTS discord_community_level_roles (
  guild_id text NOT NULL,
  level integer NOT NULL,
  role_id text NOT NULL,
  created_by_discord_user_id text,
  created_by_admin_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, level),
  UNIQUE (guild_id, role_id),
  CONSTRAINT discord_community_level_roles_ids_check CHECK (
    guild_id ~ '^[0-9]{17,20}$' AND role_id ~ '^[0-9]{17,20}$'
      AND (created_by_discord_user_id IS NULL OR created_by_discord_user_id ~ '^[0-9]{17,20}$')
      AND (created_by_discord_user_id IS NOT NULL OR created_by_admin_user_id IS NOT NULL)
  ),
  CONSTRAINT discord_community_level_roles_level_check CHECK (level BETWEEN 0 AND 100)
);

UPDATE api_keys
SET scopes = array_append(scopes, 'discord:community-xp')
WHERE prefix = 'pwa__WZ4VvUngxA4'
  AND is_active = true
  AND NOT ('discord:community-xp' = ANY(scopes));
