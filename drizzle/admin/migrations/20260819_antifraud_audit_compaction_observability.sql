-- Preserve the historical append-only audit exactly as written while making
-- future signed-monitor redeliveries compact. Existing rows default to false,
-- so the unique index can be installed without deleting or rewriting any
-- security evidence. The application opts new automated receipts into it.
ALTER TABLE antifraud_security_audit_events
  ADD COLUMN IF NOT EXISTS dedupe_automated_receipt boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS antifraud_security_audit_automated_receipt_idx
  ON antifraud_security_audit_events (action, idempotency_key_hash)
  WHERE dedupe_automated_receipt
    AND idempotency_key_hash IS NOT NULL
    AND outcome = 'allowed';

-- The audit viewer supports contains-search (`ILIKE '%term%'`). Its existing
-- chronological index is excellent for an unfiltered page but must scan the
-- table for a sparse action match. pg_trgm is already an Admin dependency; the
-- guard keeps this migration independently replayable.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS antifraud_security_audit_action_trgm_idx
  ON antifraud_security_audit_events USING gin (action gin_trgm_ops);

-- PostgreSQL already preloads this library on the managed Railway database.
-- Installing the extension exposes statement history to query diagnostics and
-- Railway/PostgreSQL observability without changing application behavior.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
