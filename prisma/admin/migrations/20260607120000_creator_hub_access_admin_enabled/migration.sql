-- Enable Creator Hub for all users with the `admin` role.
-- Gate: canAccessCreatorHub() reads creator_hub_access_admin_enabled.

INSERT INTO "admin_settings" ("key", "value", "updated_at", "updated_by")
VALUES ('creator_hub_access_admin_enabled', 'true', NOW(), NULL)
ON CONFLICT ("key") DO UPDATE
SET "value" = 'true', "updated_at" = NOW();
