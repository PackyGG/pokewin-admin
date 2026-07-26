-- Restore the shared dashboard notification service after the staff/quiz
-- removal migration. These tables are independent Admin DB infrastructure.

CREATE TABLE IF NOT EXISTS "staff_notifications" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_user_id" UUID NOT NULL REFERENCES "admin_users"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "href" TEXT,
  "metadata" JSONB,
  "read_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "staff_notifications_user_created_idx"
  ON "staff_notifications" ("admin_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "staff_notifications_user_unread_idx"
  ON "staff_notifications" ("admin_user_id")
  WHERE "read_at" IS NULL;

CREATE TABLE IF NOT EXISTS "staff_notification_channels" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_user_id" UUID NOT NULL REFERENCES "admin_users"("id") ON DELETE CASCADE,
  "channel" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "verified_at" TIMESTAMPTZ(6),
  "verification_code" TEXT,
  "verification_sent_at" TIMESTAMPTZ(6),
  "verify_attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "last_sent_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_notification_channels_user_channel_uniq"
  ON "staff_notification_channels" ("admin_user_id", "channel");

CREATE TABLE IF NOT EXISTS "staff_notification_prefs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_user_id" UUID NOT NULL REFERENCES "admin_users"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "in_app" BOOLEAN NOT NULL DEFAULT true,
  "discord" BOOLEAN NOT NULL DEFAULT true,
  "telegram" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_notification_prefs_user_kind_uniq"
  ON "staff_notification_prefs" ("admin_user_id", "kind");
