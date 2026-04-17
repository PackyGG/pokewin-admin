-- Admin self-profile fields. Editable by the admin themselves via /profile.
-- display_username: label shown in the header/UI; falls back to `username` when null.
-- profile_image / profile_image_mime: raw avatar bytes + MIME stored directly in DB.

-- AlterTable
ALTER TABLE "admin_users"
  ADD COLUMN "display_username"   TEXT,
  ADD COLUMN "profile_image"      BYTEA,
  ADD COLUMN "profile_image_mime" TEXT;
