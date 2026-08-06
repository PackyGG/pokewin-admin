-- Durable creator deal/reward consent workflow. ADMIN database only.
-- The actual creator deal remains owned by the customer backend; this schema
-- stores the immutable proposal, Discord consent, delivery, and recovery state.

CREATE TABLE IF NOT EXISTS creator_agreement_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INTEGER NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  published_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT creator_agreement_documents_version_check CHECK (version > 0),
  CONSTRAINT creator_agreement_documents_checksum_check CHECK (checksum ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS creator_agreement_lines (
  document_id UUID NOT NULL REFERENCES creator_agreement_documents(id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (document_id, line_number),
  CONSTRAINT creator_agreement_lines_number_check CHECK (line_number > 0),
  CONSTRAINT creator_agreement_lines_text_check CHECK (length(btrim(text)) BETWEEN 1 AND 1000)
);

CREATE INDEX IF NOT EXISTS creator_agreement_documents_published_idx
  ON creator_agreement_documents (published_at DESC, version DESC);

CREATE TABLE IF NOT EXISTS creator_deal_approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_user_id TEXT NOT NULL,
  discord_setup_id UUID NOT NULL REFERENCES discord_creator_setups(id) ON DELETE RESTRICT,
  creator_discord_user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  chat_channel_id TEXT NOT NULL,
  deal_payload JSONB NOT NULL,
  reward_payload JSONB,
  agreement_document_id UUID NOT NULL REFERENCES creator_agreement_documents(id) ON DELETE RESTRICT,
  agreement_version INTEGER NOT NULL,
  agreement_lines JSONB NOT NULL,
  agreement_checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_delivery',
  submitted_by UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  summary_message_id TEXT,
  delivery_attempt_count INTEGER NOT NULL DEFAULT 0,
  delivery_max_attempts INTEGER NOT NULL DEFAULT 10,
  delivery_available_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  delivery_lease_token UUID,
  delivery_lease_owner TEXT,
  delivery_leased_until TIMESTAMPTZ(6),
  decision_interaction_id TEXT,
  decision_actor_discord_user_id TEXT,
  continued_at TIMESTAMPTZ(6),
  approved_at TIMESTAMPTZ(6),
  declined_at TIMESTAMPTZ(6),
  backend_deal_id TEXT,
  backend_create_attempted_at TIMESTAMPTZ(6),
  reward_program_id UUID,
  provisioning_attempt_count INTEGER NOT NULL DEFAULT 0,
  provisioning_lease_token UUID,
  provisioning_leased_until TIMESTAMPTZ(6),
  last_error_step TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ(6),
  CONSTRAINT creator_deal_approval_creator_user_check CHECK (length(creator_user_id) BETWEEN 8 AND 64 AND creator_user_id ~ '^[A-Za-z0-9_-]+$'),
  CONSTRAINT creator_deal_approval_discord_ids_check CHECK (
    creator_discord_user_id ~ '^[0-9]{17,20}$' AND
    guild_id ~ '^[0-9]{17,20}$' AND
    category_id ~ '^[0-9]{17,20}$' AND
    chat_channel_id ~ '^[0-9]{17,20}$'
  ),
  CONSTRAINT creator_deal_approval_payload_check CHECK (
    jsonb_typeof(deal_payload) = 'object' AND
    (reward_payload IS NULL OR jsonb_typeof(reward_payload) = 'object') AND
    jsonb_typeof(agreement_lines) = 'array' AND jsonb_array_length(agreement_lines) > 0
  ),
  CONSTRAINT creator_deal_approval_checksum_check CHECK (agreement_checksum ~ '^[a-f0-9]{64}$'),
  CONSTRAINT creator_deal_approval_status_check CHECK (status IN (
    'pending_delivery', 'awaiting_continue', 'awaiting_decision',
    'approved_provisioning', 'provisioning_failed', 'completed',
    'declined', 'delivery_failed', 'cancelled', 'expired'
  )),
  CONSTRAINT creator_deal_approval_delivery_attempt_check CHECK (
    delivery_attempt_count >= 0 AND delivery_max_attempts BETWEEN 1 AND 25
  ),
  CONSTRAINT creator_deal_approval_provision_attempt_check CHECK (provisioning_attempt_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS creator_deal_approval_one_unresolved_creator
  ON creator_deal_approval_requests (creator_user_id)
  WHERE status IN (
    'pending_delivery', 'awaiting_continue', 'awaiting_decision',
    'approved_provisioning', 'provisioning_failed', 'delivery_failed'
  );
CREATE INDEX IF NOT EXISTS creator_deal_approval_creator_history_idx
  ON creator_deal_approval_requests (creator_user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS creator_deal_approval_delivery_claim_idx
  ON creator_deal_approval_requests (guild_id, delivery_available_at, created_at)
  WHERE status = 'pending_delivery';

CREATE TABLE IF NOT EXISTS creator_deal_approval_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES creator_deal_approval_requests(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_admin_user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  actor_discord_user_id TEXT,
  interaction_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT creator_deal_approval_events_actor_check CHECK (actor_kind IN ('admin', 'creator', 'bot', 'system')),
  CONSTRAINT creator_deal_approval_events_discord_actor_check CHECK (
    actor_discord_user_id IS NULL OR actor_discord_user_id ~ '^[0-9]{17,20}$'
  )
);
CREATE INDEX IF NOT EXISTS creator_deal_approval_events_request_idx
  ON creator_deal_approval_events (request_id, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS creator_deal_approval_events_interaction_unique
  ON creator_deal_approval_events (interaction_id)
  WHERE interaction_id IS NOT NULL;

ALTER TABLE creator_reward_programs
  ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS source_approval_request_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS creator_reward_programs_source_approval_unique
  ON creator_reward_programs (source_approval_request_id)
  WHERE source_approval_request_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'creator_reward_programs_source_approval_fkey'
      AND conrelid = 'creator_reward_programs'::regclass
  ) THEN
    ALTER TABLE creator_reward_programs
      ADD CONSTRAINT creator_reward_programs_source_approval_fkey
      FOREIGN KEY (source_approval_request_id)
      REFERENCES creator_deal_approval_requests(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'creator_reward_programs_end_after_start'
      AND conrelid = 'creator_reward_programs'::regclass
  ) THEN
    ALTER TABLE creator_reward_programs
      ADD CONSTRAINT creator_reward_programs_end_after_start
      CHECK (ends_at IS NULL OR ends_at > accrual_start_at);
  END IF;
END $$;
