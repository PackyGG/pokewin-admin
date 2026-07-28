CREATE TABLE IF NOT EXISTS risky_locations (
  country_code text PRIMARY KEY,
  monitor_duration_seconds integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risky_locations_country_code_check
    CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT risky_locations_duration_check
    CHECK (monitor_duration_seconds BETWEEN 60 AND 3600)
);

CREATE TABLE IF NOT EXISTS risky_location_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code text NOT NULL REFERENCES risky_locations(country_code),
  action text NOT NULL CHECK (action IN ('created', 'updated')),
  actor_id text NOT NULL,
  actor_username text,
  idempotency_key uuid NOT NULL UNIQUE,
  before_state jsonb,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS risky_locations_enabled_code_idx
  ON risky_locations(country_code)
  WHERE enabled;
