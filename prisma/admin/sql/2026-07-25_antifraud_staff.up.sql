-- Antifraud webapp + staff system — the whole thing lives in the ADMIN DB.
--
-- The MAIN (prod game) DB is READ-ONLY for this feature. Account reviews carry
-- the reviewed player's MAIN-DB `user.id` as a LOOSE TEXT column (exactly like
-- admin_audit_events.target_user_id) — there is no cross-DB FK and no prod
-- schema change anywhere in this file.
--
-- Three groups of tables:
--
--   staff_*      the staff account layer that rides on top of admin_users:
--                profile, points ledger, level, quizzes, in-app notifications
--                and the per-staff Discord/Telegram notification channels.
--
--   antifraud_*  the fraud workspace itself: the account-review queue, its
--                per-review note trail, and the signal inbox that the separate
--                WebSocket backend service will write into once it exists.
--
-- Purely ADDITIVE and idempotent. Written as raw SQL (this repo's
-- prisma/admin/sql convention) rather than `prisma migrate dev` / `db push`:
-- the CLI does not see this schema's migration history from the default path
-- (so `migrate dev` could offer to RESET the admin DB), and several perf
-- indexes exist in the DB but are deliberately UNMODELED in schema.prisma, so
-- a `db push` diff would try to DROP them.
--
-- Apply with:
--   npx prisma db execute --file prisma/admin/sql/2026-07-25_antifraud_staff.up.sql \
--     --config=prisma/admin/prisma.config.ts

-- ═══════════════════════════════════════════════════════════════════════════
--  STAFF LAYER
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── staff_profiles ───────────────────────────────────────────────────────
-- One row per admin_user that has entered the staff system. Created lazily on
-- first visit (`ensureStaffProfile`) so no backfill is needed and an admin who
-- never opens the workspace never gets a row.
--
-- The AVATAR deliberately does NOT live here: admin_users already stores
-- profile_image / profile_image_mime and /api/admin/avatar/[id] already serves
-- it everywhere in the dashboard. A second avatar column would fork the
-- identity — the staff profile page writes the EXISTING columns instead.
--
-- `points_total` / `level` are DENORMALIZED roll-ups of staff_point_events.
-- The events table is the immutable source of truth (same discipline as the
-- game ledger); these two columns exist so the members board and the header
-- can read a level without aggregating the ledger on every request. They are
-- only ever written by `awardStaffPoints`, in the same transaction as the
-- event row, so they cannot drift.
CREATE TABLE IF NOT EXISTS "staff_profiles" (
  "admin_user_id"     UUID PRIMARY KEY REFERENCES "admin_users"("id") ON DELETE CASCADE,
  -- Staff-facing display name. Falls back to admin_users.display_username,
  -- then username, at read time — never NOT NULL so it stays optional.
  "display_name"      TEXT,
  -- Free-text job title shown under the name ("Support Lead", "Fraud Analyst").
  "title"             TEXT,
  "bio"               TEXT,
  -- One of the shared AccentColor tokens (modern-panels TILE_COLORS). Drives
  -- the member card / profile hero accent. Validated in code, not by a CHECK,
  -- so adding a token later needs no migration.
  "accent"            TEXT           NOT NULL DEFAULT 'blue',
  -- Denormalized roll-ups of staff_point_events (see above).
  "points_total"      INTEGER        NOT NULL DEFAULT 0,
  "level"             INTEGER        NOT NULL DEFAULT 1,
  -- Cheap counters for the members board, same write-with-the-event contract.
  "quizzes_completed" INTEGER        NOT NULL DEFAULT 0,
  "reviews_resolved"  INTEGER        NOT NULL DEFAULT 0,
  "last_seen_at"      TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- Members board ordering: highest points first.
CREATE INDEX IF NOT EXISTS "staff_profiles_points_idx"
  ON "staff_profiles" ("points_total" DESC);

-- ─── staff_point_events ───────────────────────────────────────────────────
-- IMMUTABLE points ledger. Every point a staff member holds is explained by
-- exactly one row here — quiz results, manual owner adjustments, review work.
-- Nothing ever updates or deletes a row; a mistake is corrected by writing a
-- compensating negative event, so the history stays auditable.
--
-- `source_kind` is one of: 'quiz' | 'review' | 'manual' | 'bonus'.
-- `source_id` points at the originating row (quiz attempt id, review id, …)
-- when there is one; NULL for a free-standing manual award.
CREATE TABLE IF NOT EXISTS "staff_point_events" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_user_id" UUID           NOT NULL REFERENCES "admin_users"("id") ON DELETE CASCADE,
  -- Signed. Negative = correction / penalty.
  "points"        INTEGER        NOT NULL,
  "source_kind"   TEXT           NOT NULL,
  "source_id"     UUID,
  -- Short human sentence shown in the profile's activity list.
  "reason"        TEXT           NOT NULL,
  -- Who caused it. NULL = the system (auto quiz scoring).
  "created_by"    UUID,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "staff_point_events_user_created_idx"
  ON "staff_point_events" ("admin_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "staff_point_events_created_idx"
  ON "staff_point_events" ("created_at" DESC);
-- Idempotency guard for automatic awards: one quiz attempt can only ever pay
-- out once, however many times the submit action is retried. Partial so
-- free-standing manual awards (source_id NULL) are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS "staff_point_events_source_uniq"
  ON "staff_point_events" ("source_kind", "source_id")
  WHERE "source_id" IS NOT NULL AND "source_kind" <> 'manual';

-- ─── staff_notifications ──────────────────────────────────────────────────
-- The in-app notification inbox behind the header bell. One row per staff
-- member per event — a broadcast ("new quiz is up") fans out to one row each
-- so read state is per person.
--
-- `kind` is one of the STAFF_NOTIFICATION_KINDS in
-- src/lib/antifraud/notifications.ts. `href` deep-links into the workspace.
CREATE TABLE IF NOT EXISTS "staff_notifications" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_user_id" UUID           NOT NULL REFERENCES "admin_users"("id") ON DELETE CASCADE,
  "kind"          TEXT           NOT NULL,
  "title"         TEXT           NOT NULL,
  "body"          TEXT,
  "href"          TEXT,
  -- Free-form extras (quiz id, review id, risk score …) for future renderers.
  "metadata"      JSONB,
  "read_at"       TIMESTAMPTZ(6),
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- The bell's two queries: the recent list for one user, and the unread count.
CREATE INDEX IF NOT EXISTS "staff_notifications_user_created_idx"
  ON "staff_notifications" ("admin_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "staff_notifications_user_unread_idx"
  ON "staff_notifications" ("admin_user_id")
  WHERE "read_at" IS NULL;

-- ─── staff_notification_channels ──────────────────────────────────────────
-- Where a staff member wants to be PINGED outside the dashboard. One row per
-- (staff, channel). Discord is the default channel; Telegram is opt-in.
--
-- VERIFICATION: a channel is only ever delivered to once `verified_at` is set.
-- The staff member enters their Discord user id / Telegram chat id, we store it
-- with a short random `verification_code`, send a test ping through the channel
-- carrying that code, and they type it back — which proves the id is really
-- theirs and not a typo'd colleague. An unverified row is inert.
CREATE TABLE IF NOT EXISTS "staff_notification_channels" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_user_id"     UUID           NOT NULL REFERENCES "admin_users"("id") ON DELETE CASCADE,
  -- 'discord' | 'telegram'
  "channel"           TEXT           NOT NULL,
  -- Discord snowflake or Telegram numeric chat id. Stored verbatim as text.
  "target"            TEXT           NOT NULL,
  "enabled"           BOOLEAN        NOT NULL DEFAULT true,
  "verified_at"       TIMESTAMPTZ(6),
  "verification_code" TEXT,
  "verification_sent_at" TIMESTAMPTZ(6),
  -- Failed verification attempts since the last code was issued. Caps brute
  -- force on the 6-digit code.
  "verify_attempts"   INTEGER        NOT NULL DEFAULT 0,
  "last_error"        TEXT,
  "last_sent_at"      TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_notification_channels_user_channel_uniq"
  ON "staff_notification_channels" ("admin_user_id", "channel");

-- ─── staff_notification_prefs ─────────────────────────────────────────────
-- Per-staff, per-event-kind delivery matrix. A MISSING row means "use the
-- default for that kind" (see STAFF_NOTIFICATION_KINDS) — we never backfill,
-- so a new event kind is opt-out rather than silently off for everyone.
CREATE TABLE IF NOT EXISTS "staff_notification_prefs" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_user_id" UUID           NOT NULL REFERENCES "admin_users"("id") ON DELETE CASCADE,
  "kind"          TEXT           NOT NULL,
  "in_app"        BOOLEAN        NOT NULL DEFAULT true,
  "discord"       BOOLEAN        NOT NULL DEFAULT true,
  "telegram"      BOOLEAN        NOT NULL DEFAULT false,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_notification_prefs_user_kind_uniq"
  ON "staff_notification_prefs" ("admin_user_id", "kind");

-- ═══════════════════════════════════════════════════════════════════════════
--  QUIZ SYSTEM
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── staff_quizzes ────────────────────────────────────────────────────────
-- Authored by owners/admins on the settings page. `status` is a lifecycle
-- flag: 'draft' | 'published' | 'archived'. Only 'published' quizzes are
-- visible to staff, and publishing is what fires the "quiz is up" notification.
--
-- `audience_roles` empty = every staff member in the workspace. Otherwise the
-- quiz only shows to staff holding one of those admin roles.
CREATE TABLE IF NOT EXISTS "staff_quizzes" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "title"             TEXT           NOT NULL,
  "description"       TEXT,
  "status"            TEXT           NOT NULL DEFAULT 'draft',
  -- Points paid per correct answer. Per-question overrides live on the
  -- question row; this is the default a new question inherits.
  "points_per_correct" INTEGER       NOT NULL DEFAULT 1,
  -- Percentage of the max score needed to "pass". Purely informational — the
  -- points are paid per correct answer either way.
  "pass_percent"      INTEGER        NOT NULL DEFAULT 70,
  -- 0 = unlimited retakes. Default 1: one shot, which is what makes the points
  -- mean something.
  "max_attempts"      INTEGER        NOT NULL DEFAULT 1,
  -- NULL = untimed.
  "time_limit_seconds" INTEGER,
  "shuffle_questions" BOOLEAN        NOT NULL DEFAULT false,
  -- Empty array = everyone. Otherwise admin_role strings.
  "audience_roles"    TEXT[]         NOT NULL DEFAULT '{}',
  "created_by"        UUID,
  "published_at"      TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "staff_quizzes_status_created_idx"
  ON "staff_quizzes" ("status", "created_at" DESC);

-- ─── staff_quiz_questions ─────────────────────────────────────────────────
-- `kind` is one of:
--   'yes_no' — exactly two options, authored automatically as Yes / No
--   'single' — multiple options, exactly ONE correct (radio)
--   'multi'  — multiple options, ANY number correct (checkbox); scored
--              all-or-nothing so a shotgun answer earns nothing
CREATE TABLE IF NOT EXISTS "staff_quiz_questions" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "quiz_id"     UUID           NOT NULL REFERENCES "staff_quizzes"("id") ON DELETE CASCADE,
  "position"    INTEGER        NOT NULL DEFAULT 0,
  "prompt"      TEXT           NOT NULL,
  "kind"        TEXT           NOT NULL DEFAULT 'single',
  -- Shown after submission next to the right answer.
  "explanation" TEXT,
  "points"      INTEGER        NOT NULL DEFAULT 1,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "staff_quiz_questions_quiz_position_idx"
  ON "staff_quiz_questions" ("quiz_id", "position");

-- ─── staff_quiz_options ───────────────────────────────────────────────────
-- The answer buttons. `is_correct` NEVER leaves the server for an in-progress
-- attempt — the take-quiz page selects only (id, label, position).
CREATE TABLE IF NOT EXISTS "staff_quiz_options" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "question_id" UUID           NOT NULL REFERENCES "staff_quiz_questions"("id") ON DELETE CASCADE,
  "position"    INTEGER        NOT NULL DEFAULT 0,
  "label"       TEXT           NOT NULL,
  "is_correct"  BOOLEAN        NOT NULL DEFAULT false,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "staff_quiz_options_question_position_idx"
  ON "staff_quiz_options" ("question_id", "position");

-- ─── staff_quiz_attempts ──────────────────────────────────────────────────
-- One row per (staff, quiz, try). `status` is 'in_progress' | 'submitted'.
-- The score + points are frozen at submit time so re-authoring the quiz later
-- can never retroactively rewrite someone's result.
CREATE TABLE IF NOT EXISTS "staff_quiz_attempts" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "quiz_id"        UUID           NOT NULL REFERENCES "staff_quizzes"("id") ON DELETE CASCADE,
  "admin_user_id"  UUID           NOT NULL REFERENCES "admin_users"("id") ON DELETE CASCADE,
  "status"         TEXT           NOT NULL DEFAULT 'in_progress',
  "score"          INTEGER        NOT NULL DEFAULT 0,
  "max_score"      INTEGER        NOT NULL DEFAULT 0,
  "correct_count"  INTEGER        NOT NULL DEFAULT 0,
  "question_count" INTEGER        NOT NULL DEFAULT 0,
  "points_awarded" INTEGER        NOT NULL DEFAULT 0,
  "started_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "submitted_at"   TIMESTAMPTZ(6)
);

CREATE INDEX IF NOT EXISTS "staff_quiz_attempts_user_started_idx"
  ON "staff_quiz_attempts" ("admin_user_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "staff_quiz_attempts_quiz_idx"
  ON "staff_quiz_attempts" ("quiz_id", "submitted_at" DESC);
-- At most ONE open attempt per (staff, quiz) — reloading the take page resumes
-- the existing attempt instead of forking a second one.
CREATE UNIQUE INDEX IF NOT EXISTS "staff_quiz_attempts_open_uniq"
  ON "staff_quiz_attempts" ("quiz_id", "admin_user_id")
  WHERE "status" = 'in_progress';

-- ─── staff_quiz_answers ───────────────────────────────────────────────────
-- The frozen per-question outcome of a submitted attempt.
CREATE TABLE IF NOT EXISTS "staff_quiz_answers" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "attempt_id"         UUID           NOT NULL REFERENCES "staff_quiz_attempts"("id") ON DELETE CASCADE,
  "question_id"        UUID           NOT NULL REFERENCES "staff_quiz_questions"("id") ON DELETE CASCADE,
  "selected_option_ids" UUID[]        NOT NULL DEFAULT '{}',
  "is_correct"         BOOLEAN        NOT NULL DEFAULT false,
  "points_awarded"     INTEGER        NOT NULL DEFAULT 0,
  "answered_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_quiz_answers_attempt_question_uniq"
  ON "staff_quiz_answers" ("attempt_id", "question_id");

-- ═══════════════════════════════════════════════════════════════════════════
--  ANTIFRAUD WORKSPACE
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── antifraud_reviews ────────────────────────────────────────────────────
-- The account-review queue. One row per account under review.
--
-- `target_user_id` is the MAIN-DB `user.id` as a LOOSE TEXT column — no
-- cross-DB FK exists or is possible (see admin_audit_events.target_user_id for
-- the same pattern). `target_username` is a DENORMALIZED snapshot taken when
-- the review is opened, so the queue renders without a MAIN-DB read per row
-- and still shows something if the account is later deleted.
--
-- `status`   : 'open' | 'in_review' | 'cleared' | 'flagged' | 'escalated'
-- `severity` : 'low' | 'medium' | 'high' | 'critical'
-- `source`   : 'manual' | 'signal' (opened by the WS backend) | 'import'
--
-- The workspace NEVER writes to the MAIN DB from here. Acting on a flagged
-- account (ban, balance adjustment) still goes through the existing, audited
-- admin surfaces — this table records the fraud team's verdict, nothing else.
CREATE TABLE IF NOT EXISTS "antifraud_reviews" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "target_user_id"   TEXT           NOT NULL,
  "target_username"  TEXT,
  "status"           TEXT           NOT NULL DEFAULT 'open',
  "severity"         TEXT           NOT NULL DEFAULT 'medium',
  "source"           TEXT           NOT NULL DEFAULT 'manual',
  -- 0–100 as delivered by the fraud backend; NULL for a manually opened case.
  "risk_score"       INTEGER,
  "reason"           TEXT           NOT NULL,
  -- Machine-readable rule keys the backend matched ('multi_account', 'vpn', …).
  "signals"          TEXT[]         NOT NULL DEFAULT '{}',
  "assigned_to"      UUID,
  "opened_by"        UUID,
  "resolution"       TEXT,
  "resolved_by"      UUID,
  "resolved_at"      TIMESTAMPTZ(6),
  "metadata"         JSONB,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- Queue ordering (newest first), the per-status filter, the "my queue" filter
-- and the per-player lookup.
CREATE INDEX IF NOT EXISTS "antifraud_reviews_status_created_idx"
  ON "antifraud_reviews" ("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "antifraud_reviews_created_idx"
  ON "antifraud_reviews" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "antifraud_reviews_assigned_idx"
  ON "antifraud_reviews" ("assigned_to", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "antifraud_reviews_target_idx"
  ON "antifraud_reviews" ("target_user_id");
-- One OPEN case per account: a repeat signal updates the live case instead of
-- stacking duplicates on the queue.
CREATE UNIQUE INDEX IF NOT EXISTS "antifraud_reviews_open_target_uniq"
  ON "antifraud_reviews" ("target_user_id")
  WHERE "status" IN ('open', 'in_review');

-- ─── antifraud_review_notes ───────────────────────────────────────────────
-- Append-only trail on a review: analyst notes AND system entries (status
-- changes, assignment, incoming signals). `kind` is 'note' | 'status' |
-- 'assign' | 'signal'.
CREATE TABLE IF NOT EXISTS "antifraud_review_notes" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "review_id"     UUID           NOT NULL REFERENCES "antifraud_reviews"("id") ON DELETE CASCADE,
  "admin_user_id" UUID,
  "kind"          TEXT           NOT NULL DEFAULT 'note',
  "body"          TEXT           NOT NULL,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "antifraud_review_notes_review_created_idx"
  ON "antifraud_review_notes" ("review_id", "created_at" DESC);

-- ─── antifraud_signals ────────────────────────────────────────────────────
-- The inbox the separate WebSocket backend service writes into (via the signed
-- /api/antifraud/ingest route). Every frame it emits is persisted here FIRST,
-- then optionally promoted into a review — so the live feed survives a browser
-- refresh and the dashboard is never the only copy of a fraud event.
--
-- `external_id` is the backend's own event id; the unique index makes ingest
-- idempotent, so a retried delivery cannot double-open a case.
CREATE TABLE IF NOT EXISTS "antifraud_signals" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "external_id"    TEXT,
  -- Backend rule/event key ('multi_account', 'bonus_abuse', 'chargeback', …).
  "kind"           TEXT           NOT NULL,
  "severity"       TEXT           NOT NULL DEFAULT 'medium',
  "risk_score"     INTEGER,
  -- MAIN-DB user.id, loose (see antifraud_reviews).
  "target_user_id" TEXT,
  "target_username" TEXT,
  "summary"        TEXT           NOT NULL,
  "payload"        JSONB,
  -- Set once the signal has been turned into / merged onto a review.
  "review_id"      UUID REFERENCES "antifraud_reviews"("id") ON DELETE SET NULL,
  "received_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "antifraud_signals_received_idx"
  ON "antifraud_signals" ("received_at" DESC);
CREATE INDEX IF NOT EXISTS "antifraud_signals_target_idx"
  ON "antifraud_signals" ("target_user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "antifraud_signals_external_uniq"
  ON "antifraud_signals" ("external_id")
  WHERE "external_id" IS NOT NULL;
