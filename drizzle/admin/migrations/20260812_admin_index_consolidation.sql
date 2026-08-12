-- Index consolidation on the two hottest ADMIN write tables.
--
-- WRITE-AMPLIFICATION IMPACT
--
-- Every row inserted into a table pays one btree insert per non-partial index
-- on that table, plus a WAL record for each, plus that index's share of every
-- HOT-update miss and of VACUUM. An index whose column list is a strict prefix
-- of another index's column list — same access method, same leading opclass,
-- neither one partial or unique — can answer nothing the longer index cannot,
-- because a btree scan on the longer index uses exactly the same leading-column
-- boundary conditions. It is pure write cost.
--
-- `admin_audit_events` takes one insert on EVERY audited admin mutation
-- (createAdminAuditEvent), and `antifraud_signals` takes one on every ingested
-- signal — the two highest-rate writers in the ADMIN database. Net effect here:
--
--   admin_audit_events   6 -> 4 always-maintained btrees (-33% index inserts
--                        per audited action; the 4 partial/expression unique
--                        indexes are unaffected and still only index the rows
--                        matching their predicates).
--   antifraud_reviews    5 -> 4 always-maintained btrees. The 3 GIN trigram
--                        indexes are untouched.
--   antifraud_signals    index COUNT is unchanged: the single-column
--                        `(target_user_id)` btree is replaced by
--                        `(target_user_id, received_at DESC)` — same one entry
--                        per insert, ~8 bytes wider — and one PARTIAL index on
--                        `review_id` is added, which only indexes signals that
--                        are actually attached to a review. This table is the
--                        one place the migration deliberately spends a little
--                        write cost to remove two sequential scans from the
--                        case-review read path (see section 3).
--
-- SAFETY
--
-- Every DROP below is guarded: the drop only runs if its superseding index is
-- currently present, valid and non-partial in this database. ADMIN migrations
-- have demonstrably sat unapplied for days, so the checked-in introspection
-- snapshot (src/lib/db-schema/admin/schema.ts) is evidence, not proof — the
-- guard makes it impossible for this file to leave a column unindexed because
-- the migration that added the replacement was never run. A skipped drop
-- RAISEs a NOTICE and the rest of the file still applies; re-running the file
-- after the missing migration lands completes the job.
--
-- Plain CREATE/DROP INDEX, not CONCURRENTLY: `npm run admin:sql` applies each
-- file inside a single transaction and CONCURRENTLY cannot run in one. The
-- CREATEs hold SHARE (blocking writes to that table for the build) and the
-- DROPs hold ACCESS EXCLUSIVE very briefly — DROP INDEX is catalog-only work.
-- The wrapper sets lock_timeout = 10s and statement_timeout = 120s, so if
-- `antifraud_signals` has grown past what a 120s in-transaction build allows,
-- this aborts cleanly and nothing is applied; run the two CREATEs by hand with
-- CONCURRENTLY in that case and then re-run this file for the drops.


-- ── 1. admin_audit_events: two legacy single-column indexes ────────────────
--
-- `admin_audit_events_admin_user_id_idx (admin_user_id)` and
-- `admin_audit_events_event_type_idx (event_type)` are the Prisma-era indexes
-- (prisma/admin/migrations/20260603000000_admin_audit_events_indexes). The
-- composites that supersede them were added on 2026-08-07 by
-- 20260807_audit_query_indexes.sql and both lead with the identical column and
-- opclass, so the actor filter, the event-type filter and the FK
-- `admin_audit_events_admin_user_id_fkey` referential-integrity probe are all
-- still served after these drops — with the ORDER BY created_at DESC that the
-- readers actually use now covered by the index instead of by a sort.
--
-- NOT dropped: `admin_audit_events_created_at_idx (created_at DESC)` is NOT a
-- prefix of either composite (they lead with a different column), so it is the
-- only index that can serve a time-window scan with no actor/type filter.
-- `admin_audit_events_target_user_id_idx` has no superseding index either.


-- ── 2. antifraud_reviews: one legacy single-column index ───────────────────
--
-- `antifraud_reviews_created_idx (created_at DESC)` is a strict prefix of
-- `antifraud_reviews_created_id_idx (created_at DESC, id DESC)`, added by
-- 20260726_antifraud_reviews_keyset_index.sql for the queue's keyset paging.
-- Same leading column, same direction, neither partial — the chronological
-- feed reads keep the exact same plan shape off the longer index.
--
-- NOT dropped: `antifraud_reviews_target_idx (target_user_id)` looks like a
-- prefix of `antifraud_reviews_open_target_uniq (target_user_id)` but that one
-- is PARTIAL on `status IN ('open','in_review')`, which the exact-id search
-- predicate does not imply, so it cannot replace the full index. The GIN
-- trigram index on the same column is a different access method and cannot
-- serve equality plus ordering. Both stay.


-- ── 3. antifraud_signals: reshape the two review-side read paths ───────────

-- 3a. The case detail view reads the related-signal trail as
--       WHERE target_user_id = $1 AND kind <> ALL($2)
--       ORDER BY received_at DESC LIMIT 25
--     (loadReviewDetail, src/lib/antifraud/reviews.ts). The existing
--     `(target_user_id)` index finds the matching rows but carries no ordering
--     information, so every open-a-case click sorts that user's entire signal
--     history to return 25 rows. Appending `received_at DESC` makes the top 25
--     an index-order prefix; the `kind` exclusion stays a cheap heap recheck.
CREATE INDEX IF NOT EXISTS antifraud_signals_target_received_idx
  ON antifraud_signals (target_user_id, received_at DESC);

-- 3b. `antifraud_signals.review_id` carries the FK to `antifraud_reviews`
--     (ON DELETE SET NULL) and its only index today is
--     `antifraud_signals_review_containment_applied_idx`, which is PARTIAL on
--     `review_id IS NOT NULL AND containment_applied_at IS NOT NULL`. Two
--     production read paths filter review_id WITHOUT any containment
--     predicate, so that predicate is not implied and the planner cannot use
--     the partial index for them — both currently sequential-scan the whole
--     append-only signal table:
--
--       • promoteConfirmedCatchallDomainsForReview
--         (src/lib/antifraud/catchall-domain-promotion.ts:84-92)
--         WHERE review_id = $1 AND kind = 'abstract_email_catchall'
--       • the catch-all lock-snapshot lookup in
--         (src/lib/antifraud/withdrawal-release.ts:219-232)
--         WHERE signal.review_id = $1 AND signal.kind = '...'
--
--     Both run on the clear-a-case path, which is exactly when an analyst is
--     waiting. The same index also serves the FK's referential-integrity probe
--     if a review is ever deleted (nothing in the repo deletes one today).
--
--     PARTIAL on `review_id IS NOT NULL` on purpose: every reader above uses
--     `review_id = $1` or `review_id IS NOT NULL`, both of which imply the
--     predicate, while signals never attached to a review — the majority on an
--     ingest table — stay out of the index entirely and cost nothing to write.
--     Kept single-column rather than adding `kind`: a review owns few signals,
--     so the second key would buy nothing and widen every entry.
CREATE INDEX IF NOT EXISTS antifraud_signals_review_idx
  ON antifraud_signals (review_id)
  WHERE review_id IS NOT NULL;

-- NOT dropped: `antifraud_signals_review_containment_applied_idx` is not made
-- redundant by 3b. Its column list is longer, and its narrower predicate means
-- 3b's shorter list does not supersede it — loadAutomatedActionTimes
-- (reviews.ts:323-340) reads MAX(containment_applied_at) per review off it.
-- `antifraud_signals_received_idx` is not a prefix of anything either.


-- ── 4. Guarded drops ───────────────────────────────────────────────────────
--
-- Each row is (table, redundant index, superseding index). The drop runs only
-- when the superseding index exists on that same table, is valid, and is not
-- partial — i.e. only when it provably answers everything the redundant one
-- did. Re-running this file is a no-op once the drops have happened.
DO $$
DECLARE
  candidate record;
BEGIN
  FOR candidate IN
    SELECT *
      FROM (VALUES
        ('admin_audit_events',
         'admin_audit_events_admin_user_id_idx',
         'admin_audit_events_admin_user_created_idx'),
        ('admin_audit_events',
         'admin_audit_events_event_type_idx',
         'admin_audit_events_event_type_created_idx'),
        ('antifraud_reviews',
         'antifraud_reviews_created_idx',
         'antifraud_reviews_created_id_idx'),
        ('antifraud_signals',
         'antifraud_signals_target_idx',
         'antifraud_signals_target_received_idx')
      ) AS t(table_name, redundant, superseding)
  LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_index AS i
        JOIN pg_class AS c ON c.oid = i.indexrelid
       WHERE c.relname = candidate.superseding
         AND i.indrelid = to_regclass(candidate.table_name)
         AND i.indisvalid
         AND i.indpred IS NULL
    ) THEN
      EXECUTE format('DROP INDEX IF EXISTS %I', candidate.redundant);
    ELSE
      RAISE NOTICE
        'Keeping %: superseding index % is missing, invalid or partial on % — apply that migration first, then re-run this file.',
        candidate.redundant, candidate.superseding, candidate.table_name;
    END IF;
  END LOOP;
END
$$;
