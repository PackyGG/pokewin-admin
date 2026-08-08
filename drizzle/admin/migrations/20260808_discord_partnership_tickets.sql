-- Durable partnership-ticket workflow for the official Discord server.
-- ADMIN database only. The production game database remains read-only.

CREATE TABLE IF NOT EXISTS discord_partnership_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL,
  source_channel_id TEXT NOT NULL,
  applicant_discord_user_id TEXT NOT NULL,
  applicant_username TEXT NOT NULL,
  applicant_display_name TEXT NOT NULL,
  submit_interaction_id TEXT NOT NULL UNIQUE,
  social_media_links TEXT NOT NULL,
  current_past_partner_sites TEXT NOT NULL,
  stats_expectations TEXT NOT NULL,
  additional_notes TEXT,
  status TEXT NOT NULL DEFAULT 'provisioning',
  ticket_channel_id TEXT,
  current_category_id TEXT,
  initial_message_id TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  last_error_step TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  last_error_at TIMESTAMPTZ(6),
  last_reconciled_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  provisioned_at TIMESTAMPTZ(6),
  offered_at TIMESTAMPTZ(6),
  close_requested_at TIMESTAMPTZ(6),
  cancelled_at TIMESTAMPTZ(6),
  closed_at TIMESTAMPTZ(6),
  closed_by_discord_user_id TEXT,
  CONSTRAINT discord_partnership_tickets_fixed_guild_check CHECK (guild_id = '1438216946318442683'),
  CONSTRAINT discord_partnership_tickets_fixed_source_check CHECK (source_channel_id = '1447322856818999337'),
  CONSTRAINT discord_partnership_tickets_ids_check CHECK (
    applicant_discord_user_id ~ '^[0-9]{17,20}$' AND
    submit_interaction_id ~ '^[0-9]{17,20}$' AND
    (ticket_channel_id IS NULL OR ticket_channel_id ~ '^[0-9]{17,20}$') AND
    (current_category_id IS NULL OR current_category_id ~ '^[0-9]{17,20}$') AND
    (initial_message_id IS NULL OR initial_message_id ~ '^[0-9]{17,20}$') AND
    (closed_by_discord_user_id IS NULL OR closed_by_discord_user_id ~ '^[0-9]{17,20}$')
  ),
  CONSTRAINT discord_partnership_tickets_text_check CHECK (
    length(applicant_username) BETWEEN 1 AND 100 AND
    length(applicant_display_name) BETWEEN 1 AND 100 AND
    length(social_media_links) BETWEEN 1 AND 1000 AND
    length(current_past_partner_sites) BETWEEN 1 AND 1000 AND
    length(stats_expectations) BETWEEN 1 AND 2000 AND
    (additional_notes IS NULL OR length(additional_notes) BETWEEN 1 AND 1000) AND
    (last_error_code IS NULL OR length(last_error_code) <= 80) AND
    (last_error_message IS NULL OR length(last_error_message) <= 1000)
  ),
  CONSTRAINT discord_partnership_tickets_status_check CHECK (
    status IN ('provisioning', 'open', 'offer_pending', 'offered', 'close_pending', 'cancelled', 'closed')
  ),
  CONSTRAINT discord_partnership_tickets_shape_check CHECK (
    (status IN ('provisioning', 'cancelled') AND ticket_channel_id IS NULL AND current_category_id IS NULL AND initial_message_id IS NULL AND provisioned_at IS NULL)
    OR
    (status IN ('open', 'offer_pending', 'offered', 'close_pending', 'closed') AND
      ticket_channel_id IS NOT NULL AND current_category_id IS NOT NULL AND initial_message_id IS NOT NULL AND provisioned_at IS NOT NULL)
  ),
  CONSTRAINT discord_partnership_tickets_closed_shape_check CHECK (
    (status = 'closed') = (closed_at IS NOT NULL) AND
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
  ),
  CONSTRAINT discord_partnership_tickets_version_check CHECK (version >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS discord_partnership_tickets_one_active_applicant
  ON discord_partnership_tickets (guild_id, applicant_discord_user_id)
  WHERE status NOT IN ('closed', 'cancelled');
CREATE UNIQUE INDEX IF NOT EXISTS discord_partnership_tickets_channel_unique
  ON discord_partnership_tickets (ticket_channel_id)
  WHERE ticket_channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS discord_partnership_tickets_recovery_idx
  ON discord_partnership_tickets (guild_id, status, updated_at, id)
  WHERE status NOT IN ('closed', 'cancelled');

CREATE TABLE IF NOT EXISTS discord_partnership_ticket_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES discord_partnership_tickets(id) ON DELETE RESTRICT,
  operation_type TEXT NOT NULL,
  interaction_id TEXT NOT NULL UNIQUE,
  actor_discord_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  from_status TEXT NOT NULL,
  target_category_id TEXT,
  observed_channel_id TEXT,
  observed_category_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ(6),
  failed_at TIMESTAMPTZ(6),
  CONSTRAINT discord_partnership_ticket_operations_type_check CHECK (operation_type IN ('offer', 'close')),
  CONSTRAINT discord_partnership_ticket_operations_status_check CHECK (status IN ('pending', 'completed', 'failed')),
  CONSTRAINT discord_partnership_ticket_operations_ids_check CHECK (
    interaction_id ~ '^[0-9]{17,20}$' AND actor_discord_user_id ~ '^[0-9]{17,20}$' AND
    (target_category_id IS NULL OR target_category_id ~ '^[0-9]{17,20}$') AND
    (observed_channel_id IS NULL OR observed_channel_id ~ '^[0-9]{17,20}$') AND
    (observed_category_id IS NULL OR observed_category_id ~ '^[0-9]{17,20}$')
  ),
  CONSTRAINT discord_partnership_ticket_operations_error_check CHECK (
    (error_code IS NULL OR length(error_code) <= 80) AND
    (error_message IS NULL OR length(error_message) <= 1000)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS discord_partnership_ticket_operations_one_pending
  ON discord_partnership_ticket_operations (ticket_id, operation_type)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS discord_partnership_ticket_operations_history_idx
  ON discord_partnership_ticket_operations (ticket_id, created_at, id);

CREATE TABLE IF NOT EXISTS discord_partnership_transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL UNIQUE REFERENCES discord_partnership_tickets(id) ON DELETE RESTRICT,
  close_operation_id UUID NOT NULL UNIQUE REFERENCES discord_partnership_ticket_operations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'building',
  message_count INTEGER NOT NULL DEFAULT 0,
  content_sha256 TEXT,
  first_message_at TIMESTAMPTZ(6),
  last_message_at TIMESTAMPTZ(6),
  log_channel_id TEXT,
  log_message_id TEXT,
  attachment_id TEXT,
  attachment_url TEXT,
  finalized_at TIMESTAMPTZ(6),
  delivered_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT discord_partnership_transcripts_status_check CHECK (status IN ('building', 'finalized', 'delivered')),
  CONSTRAINT discord_partnership_transcripts_count_check CHECK (message_count >= 0),
  CONSTRAINT discord_partnership_transcripts_checksum_check CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT discord_partnership_transcripts_ids_check CHECK (
    (log_channel_id IS NULL OR log_channel_id ~ '^[0-9]{17,20}$') AND
    (log_message_id IS NULL OR log_message_id ~ '^[0-9]{17,20}$') AND
    (attachment_id IS NULL OR attachment_id ~ '^[0-9]{17,20}$')
  )
);

CREATE TABLE IF NOT EXISTS discord_partnership_transcript_batches (
  batch_id UUID PRIMARY KEY,
  transcript_id UUID NOT NULL REFERENCES discord_partnership_transcripts(id) ON DELETE RESTRICT,
  payload_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT discord_partnership_transcript_batches_checksum_check CHECK (payload_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS discord_partnership_transcript_batches_transcript_idx
  ON discord_partnership_transcript_batches (transcript_id, created_at, batch_id);

CREATE TABLE IF NOT EXISTS discord_partnership_transcript_messages (
  transcript_id UUID NOT NULL REFERENCES discord_partnership_transcripts(id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL,
  author_id TEXT,
  author_username TEXT,
  author_display_name TEXT,
  author_avatar_url TEXT,
  content TEXT,
  discord_created_at TIMESTAMPTZ(6) NOT NULL,
  discord_edited_at TIMESTAMPTZ(6),
  referenced_message_id TEXT,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  embeds JSONB NOT NULL DEFAULT '[]'::jsonb,
  stickers JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (transcript_id, message_id),
  CONSTRAINT discord_partnership_transcript_messages_ordinal_unique UNIQUE (transcript_id, ordinal),
  CONSTRAINT discord_partnership_transcript_messages_ids_check CHECK (
    message_id ~ '^[0-9]{17,20}$' AND
    (author_id IS NULL OR author_id ~ '^[0-9]{17,20}$') AND
    (referenced_message_id IS NULL OR referenced_message_id ~ '^[0-9]{17,20}$')
  ),
  CONSTRAINT discord_partnership_transcript_messages_text_check CHECK (
    (author_username IS NULL OR length(author_username) <= 100) AND
    (author_display_name IS NULL OR length(author_display_name) <= 100) AND
    (content IS NULL OR length(content) <= 4000)
  ),
  CONSTRAINT discord_partnership_transcript_messages_json_check CHECK (
    jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 10 AND
    jsonb_typeof(embeds) = 'array' AND jsonb_array_length(embeds) <= 10 AND
    jsonb_typeof(stickers) = 'array' AND jsonb_array_length(stickers) <= 3
  )
);
CREATE INDEX IF NOT EXISTS discord_partnership_transcript_messages_order_idx
  ON discord_partnership_transcript_messages (transcript_id, ordinal);
