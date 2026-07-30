-- Staff announcements belong to the dedicated staff-notification workflow,
-- not the Fraud Discord Routing event catalog.
--
-- Existing dependencies are removed first so this stays safe if the event was
-- briefly configured before it was withdrawn.

DELETE FROM antifraud_dashboard_notification_rules
WHERE event_key = 'staff.announcement';

DELETE FROM discord_notification_routes
WHERE event_key = 'staff.announcement';

DELETE FROM discord_notification_jobs
WHERE event_key = 'staff.announcement';

DELETE FROM discord_notification_events
WHERE event_key = 'staff.announcement';
