-- Provider-independent identity age and tightly bounded campaign correlation.
-- All state lives in Antifraud; MAIN remains read-only to this service.
ALTER TABLE signup_identity_snapshots
  ADD COLUMN IF NOT EXISTS discord_account_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS network_asn text,
  ADD COLUMN IF NOT EXISTS generated_username boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS signup_identity_snapshot_country_time_idx
  ON signup_identity_snapshots(country_code, source_created_at DESC)
  WHERE country_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS signup_identity_snapshot_country_asn_time_idx
  ON signup_identity_snapshots(country_code, network_asn, source_created_at DESC)
  WHERE country_code IS NOT NULL AND network_asn IS NOT NULL;

INSERT INTO score_weights(key, points, updated_by) VALUES
  ('discord_account_under_7d', 40, 'system:signup-campaign-v4'),
  ('discord_account_under_30d', 25, 'system:signup-campaign-v4'),
  ('discord_account_under_90d', 10, 'system:signup-campaign-v4'),
  ('signup_campaign_network_burst', 25, 'system:signup-campaign-v4'),
  ('signup_campaign_generated_burst', 35, 'system:signup-campaign-v4')
ON CONFLICT (key) DO NOTHING;
