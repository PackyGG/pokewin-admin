-- Store the exact five simulated outcomes that informed an EOS selection so
-- staff can distinguish a broken flow from an unavailable requested outcome.
ALTER TABLE battle_test_eos_selections
  ADD COLUMN IF NOT EXISTS audit jsonb;

ALTER TABLE battle_test_eos_selections
  DROP CONSTRAINT IF EXISTS battle_test_eos_selections_audit_object;
ALTER TABLE battle_test_eos_selections
  ADD CONSTRAINT battle_test_eos_selections_audit_object
  CHECK (audit IS NULL OR jsonb_typeof(audit) = 'object');
