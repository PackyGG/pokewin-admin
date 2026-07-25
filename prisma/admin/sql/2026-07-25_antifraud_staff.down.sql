-- Rollback for 2026-07-25_antifraud_staff.up.sql.
--
-- DESTRUCTIVE — drops the whole antifraud + staff system including every
-- points ledger row, quiz result and account review. Only run this if the
-- feature is being abandoned. Child tables first (FK order); the CASCADEs on
-- the FKs would handle it anyway, but explicit order documents the graph.

DROP TABLE IF EXISTS "staff_quiz_answers";
DROP TABLE IF EXISTS "staff_quiz_attempts";
DROP TABLE IF EXISTS "staff_quiz_options";
DROP TABLE IF EXISTS "staff_quiz_questions";
DROP TABLE IF EXISTS "staff_quizzes";

DROP TABLE IF EXISTS "staff_notification_prefs";
DROP TABLE IF EXISTS "staff_notification_channels";
DROP TABLE IF EXISTS "staff_notifications";
DROP TABLE IF EXISTS "staff_point_events";
DROP TABLE IF EXISTS "staff_profiles";

DROP TABLE IF EXISTS "antifraud_signals";
DROP TABLE IF EXISTS "antifraud_review_notes";
DROP TABLE IF EXISTS "antifraud_reviews";
