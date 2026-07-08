-- Consolidate `contacted_vip` and `confirmed_vip` into a single `vip` tag,
-- and drop `fraud_abuser`. Keep in sync with USER_TAG_VALUES in
-- src/app/(admin)/users/[id]/actions.ts and UserTagValue in
-- src/lib/queries/user-tags.ts.
--
-- As of 2026-07-08 (verified read-only against the live admin DB), zero
-- rows used 'contacted_vip', 'confirmed_vip', or 'fraud_abuser' — only
-- 'wager_abuser' had rows (9). No data backfill is required.
ALTER TABLE "admin_user_tags"
    DROP CONSTRAINT "admin_user_tags_tag_value_check";

ALTER TABLE "admin_user_tags"
    ADD CONSTRAINT "admin_user_tags_tag_value_check"
    CHECK ("tag" IN ('vip', 'wager_abuser'));
