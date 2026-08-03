-- Split operator IP rules into hard blocks and non-containing known VPN risk.
-- Existing rules remain hard blocks. Fingerprints may never use the VPN effect.

ALTER TABLE identifier_blocklists
  ADD COLUMN IF NOT EXISTS effect text NOT NULL DEFAULT 'block';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'identifier_blocklists_effect_check'
  ) THEN
    ALTER TABLE identifier_blocklists
      ADD CONSTRAINT identifier_blocklists_effect_check CHECK (
        effect = 'block' OR (kind = 'ip' AND effect = 'known_vpn')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS identifier_blocklists_active_effect_idx
  ON identifier_blocklists(kind, effect, created_at DESC)
  WHERE enabled;
