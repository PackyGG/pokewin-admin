BEGIN;

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

COMMIT;
