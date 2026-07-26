CREATE TABLE IF NOT EXISTS creator_reward_offer_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  program_id uuid NOT NULL,
  user_id text NOT NULL,
  leg text NOT NULL,
  run_started_at timestamptz(6) NOT NULL,
  basis_position_usd numeric(20, 2) NOT NULL,
  basis_usd numeric(20, 2) DEFAULT '0' NOT NULL,
  claimable_at timestamptz(6) DEFAULT now() NOT NULL,
  expires_at timestamptz(6) NOT NULL,
  claimed_at timestamptz(6),
  CONSTRAINT creator_reward_offer_windows_program_id_fkey
    FOREIGN KEY (program_id)
    REFERENCES creator_reward_programs(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS creator_reward_offer_windows_unit_key
  ON creator_reward_offer_windows
    (program_id, user_id, leg, run_started_at, basis_position_usd);

CREATE INDEX IF NOT EXISTS creator_reward_offer_windows_lookup_idx
  ON creator_reward_offer_windows (program_id, user_id, leg, expires_at);

CREATE INDEX IF NOT EXISTS creator_reward_offer_windows_open_expiry_idx
  ON creator_reward_offer_windows (expires_at)
  WHERE claimed_at IS NULL;
