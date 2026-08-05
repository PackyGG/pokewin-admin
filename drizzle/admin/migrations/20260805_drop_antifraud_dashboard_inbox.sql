-- Remove the retired Fraud dashboard inbox rule system. The shared manual
-- staff inbox (`staff_notifications`) is intentionally preserved.
DROP TABLE IF EXISTS antifraud_dashboard_notification_rules;
