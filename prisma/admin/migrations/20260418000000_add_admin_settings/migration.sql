-- Key/value store for admin-panel configuration (e.g. the house
-- affiliate user id used by the Ads tracking feature). Intentionally
-- generic so future global settings can reuse the same table instead
-- of spawning bespoke one-row models.

CREATE TABLE "admin_settings" (
  "key" TEXT PRIMARY KEY,
  "value" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by" UUID
);
