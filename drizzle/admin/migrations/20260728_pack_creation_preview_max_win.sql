ALTER TABLE pack_creation_requests
  ADD COLUMN IF NOT EXISTS preview_max_win numeric(20, 2);
