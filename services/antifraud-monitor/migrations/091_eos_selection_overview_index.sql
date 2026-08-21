-- Keep the environment-scoped, 30-day EOS overview on completed audit rows.
CREATE INDEX IF NOT EXISTS battle_test_eos_selections_environment_selected_idx
  ON battle_test_eos_selections (environment, selected_at DESC)
  WHERE audit IS NOT NULL AND response IS NOT NULL;
