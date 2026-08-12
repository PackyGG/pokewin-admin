-- Two read paths in the antifraud webapp that currently have no leading index.
--
-- 1) /antifraud/auto-bans lists, counts and groups `antifraud_signals` rows
--    filtered on `kind = 'whop_history_auto_ban'` and ordered by
--    (received_at DESC, id DESC) with OFFSET paging. The only matching index is
--    antifraud_signals_received_idx (received_at DESC) — it has no `kind`, so
--    every page walks the whole signal stream and discards other kinds.
--    Leading `kind` also serves the two sibling COUNT/GROUP BY statements the
--    page issues alongside the row read.
CREATE INDEX IF NOT EXISTS antifraud_signals_kind_received_idx
  ON antifraud_signals (kind, received_at DESC, id DESC);

-- 2) The antifraud overview's 30-day "accounts caught" bucket filters
--    `status = 'flagged'` and ranges on `resolved_at`. The only index leading
--    with `status` is antifraud_reviews_status_created_idx, whose second key is
--    created_at — so Postgres reads EVERY flagged review ever and filters
--    resolved_at afterwards. 'flagged' is terminal, so that population only
--    grows. Equality folded into the partial predicate, the range column left
--    as the single key, so the 30-day window becomes a bounded range scan.
CREATE INDEX IF NOT EXISTS antifraud_reviews_flagged_resolved_idx
  ON antifraud_reviews (resolved_at DESC)
  WHERE status = 'flagged' AND resolved_at IS NOT NULL;
