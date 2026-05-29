-- CreateTable
CREATE TABLE "admin_user_tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "target_user_id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "set_by_admin_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_user_tags_pkey" PRIMARY KEY ("id")
);

-- Tag value allowlist enforced at the SQL layer so an out-of-band
-- write (script, manual SQL, etc.) can't add a tag value the UI
-- doesn't render. Update this CHECK alongside the Zod enum in
-- src/app/(admin)/users/[id]/actions.ts if you add a new tag.
ALTER TABLE "admin_user_tags"
    ADD CONSTRAINT "admin_user_tags_tag_value_check"
    CHECK ("tag" IN ('contacted_vip', 'confirmed_vip'));

-- One row per (user, tag). Re-tagging the same user with the same
-- tag is idempotent — the upsert path in setUserTag relies on this.
CREATE UNIQUE INDEX "admin_user_tags_user_tag_unique"
    ON "admin_user_tags"("target_user_id", "tag");

-- Lookup indexes — "show tags for this user" hits the per-user index;
-- "find all confirmed VIPs" / "list contacted VIPs" hits the per-tag.
CREATE INDEX "admin_user_tags_target_user_id_idx"
    ON "admin_user_tags"("target_user_id");

CREATE INDEX "admin_user_tags_tag_idx"
    ON "admin_user_tags"("tag");

-- FK to admin_users — when an admin account is deleted, drop their
-- tag assignments rather than orphan them. The audit_events table
-- keeps the historical record either way.
ALTER TABLE "admin_user_tags"
    ADD CONSTRAINT "admin_user_tags_set_by_admin_id_fkey"
    FOREIGN KEY ("set_by_admin_id") REFERENCES "admin_users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
