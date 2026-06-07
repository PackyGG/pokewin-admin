-- Extend the admin_user_tags allowlist with `fraud_abuser`.
-- Keep in sync with USER_TAG_VALUES in actions.ts and UserTagValue in user-tags.ts.
ALTER TABLE "admin_user_tags"
    DROP CONSTRAINT "admin_user_tags_tag_value_check";

ALTER TABLE "admin_user_tags"
    ADD CONSTRAINT "admin_user_tags_tag_value_check"
    CHECK ("tag" IN ('contacted_vip', 'confirmed_vip', 'wager_abuser', 'fraud_abuser'));
