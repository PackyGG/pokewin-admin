CREATE TABLE IF NOT EXISTS score_weights (
  key text PRIMARY KEY,
  points integer NOT NULL CHECK (points BETWEEN -500 AND 500),
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO score_weights(key, points)
VALUES
  ('shared_device_two_accounts', 70),
  ('shared_device_three_plus_accounts', 95),
  ('ip_velocity_10m', 50),
  ('ip_velocity_30m', 80),
  ('ipv6_subnet_velocity', 40),
  ('existing_alt_flag', 45),
  ('generated_username', 15),
  ('missing_email', 5),
  ('fingerprint_missing', 15),
  ('fingerprint_bad_bot', 80),
  ('fingerprint_vpn', 20),
  ('fingerprint_proxy', 35),
  ('fingerprint_tor', 65),
  ('fingerprint_incognito', 10),
  ('fingerprint_tampering', 70),
  ('fingerprint_virtual_machine', 25),
  ('fingerprint_high_activity', 45),
  ('fingerprint_suspect_score_maximum', 50),
  ('proxycheck_anonymous_lower_risk', 25),
  ('proxycheck_anonymous_high_risk', 55),
  ('proxycheck_risk_medium', 25),
  ('proxycheck_risk_high', 45),
  ('crypto_deposit', -20),
  ('fiat_deposit', 20),
  ('deposit_unclassified', 20),
  ('paid_pack_opened', -5),
  ('reward_opened', 20),
  ('bonus_received', 20)
ON CONFLICT (key) DO NOTHING;
