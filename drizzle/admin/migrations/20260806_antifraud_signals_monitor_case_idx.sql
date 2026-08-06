-- Antifraud signals: index the monitor case id carried inside `payload`.
--
-- WHY: `/antifraud/reviews?monitorCaseId=<uuid>` is the antifraud-monitor
-- deep-link. Resolving it runs `getReviewIdForMonitorCase`
-- (`src/lib/antifraud/reviews.ts`):
--
--   SELECT signal.review_id
--     FROM antifraud_signals signal
--    WHERE signal.review_id IS NOT NULL
--      AND (signal.payload ->> 'caseId' = $1
--           OR signal.payload ->> 'monitorCaseId' = $1)
--    ORDER BY signal.received_at DESC
--    LIMIT 1
--
-- `antifraud_signals` carries indexes on `external_id`, `received_at`,
-- `target_user_id` and the containment outbox — NONE of them can serve a JSONB
-- expression predicate. There is also no date bound on the probe, so a case id
-- that matches nothing (a stale link, a signal that never opened a review)
-- walks the whole table and evaluates the two `->>` extractions per row. The
-- lookup is on the reviews page's critical path, so that walk is time an
-- analyst spends staring at an empty screen.
--
-- Two indexes, not one: the query ORs two different JSONB keys, and a single
-- expression index cannot serve both. Postgres BitmapOrs them.
--
-- Partial on purpose. `review_id IS NOT NULL` is in the query's own WHERE, so
-- the partial predicate is implied by it and the planner can use the index;
-- `payload ? '<key>'` keeps every signal that carries no case id (the majority)
-- out of the index entirely. Both stay narrow and cheap to maintain on an
-- append-only ingest table.
--
-- `payload` is nullable; `payload ? 'caseId'` is NULL-safe (NULL, not true), so
-- payload-less rows are simply excluded.
--
-- Plain CREATE INDEX, not CONCURRENTLY: `npm run admin:sql` applies each file
-- inside one transaction, and CONCURRENTLY cannot run in a transaction block.
-- This is the ADMIN database and the table is small enough for the brief write
-- lock; if it ever is not, run the two statements by hand with CONCURRENTLY.

CREATE INDEX IF NOT EXISTS antifraud_signals_monitor_case_idx
  ON antifraud_signals ((payload ->> 'caseId'))
  WHERE review_id IS NOT NULL AND payload ? 'caseId';

CREATE INDEX IF NOT EXISTS antifraud_signals_monitor_case_alt_idx
  ON antifraud_signals ((payload ->> 'monitorCaseId'))
  WHERE review_id IS NOT NULL AND payload ? 'monitorCaseId';
