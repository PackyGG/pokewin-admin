-- 004_audit_hardening.sql
--
-- `subjects.signup_ip` was declared `inet` in 001_initial.sql, but the MAIN
-- source column `user.signup_ip` is plain `text` and is never validated: it can
-- hold an X-Forwarded-For chain, a `host:port` pair, or the literal string
-- `unknown`. The engine passes that value straight into the INSERT, so a single
-- malformed row raised `invalid input syntax for type inet`, aborted the tick,
-- left the ingestion cursor unmoved, and then failed identically forever —
-- killing ALL antifraud ingestion.
--
-- The mirror column therefore stores exactly what MAIN stores. Where inet
-- semantics are genuinely needed (the IPv6 /64 household check) the cast is
-- guarded in SQL so a malformed value yields NULL instead of an error.
--
-- Idempotent and data-preserving: the ALTER only runs while the column is still
-- `inet`, and `host()` renders the stored address without the implicit /32 or
-- /128 masklen, so the text value matches what MAIN holds.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = 'subjects'
      AND a.attname = 'signup_ip'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.atttypid = 'inet'::regtype
  ) THEN
    ALTER TABLE subjects
      ALTER COLUMN signup_ip TYPE text USING host(signup_ip);
  END IF;
END
$$;

-- The bounded case list orders by this exact severity rank then updated_at.
-- Keep the expression byte-for-byte aligned with GET /v1/cases.
CREATE INDEX IF NOT EXISTS cases_severity_rank_updated_idx
  ON cases (
    (CASE severity
      WHEN 'critical' THEN 4
      WHEN 'high' THEN 3
      WHEN 'medium' THEN 2
      ELSE 1
    END) DESC,
    updated_at DESC
  );

ALTER TABLE service_audit_events
  ADD COLUMN IF NOT EXISTS actor_username text;
