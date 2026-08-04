-- Remove the OLD manual Discord link system from the admin DB.
--
-- The hand-typed Discord handle + channel URL (creator_socials platform
-- 'discord' + creator_socials.discord_channel_url) are replaced by the
-- Discord creator-setup bot link (discord_creator_setups.creator_user_id).
--
-- NOTE: reward_page_url is ALSO carried on the platform='discord' row
-- (see src/lib/creator-social-urls.ts persistRewardPageUrl), so rows that
-- still carry a reward-page URL are KEPT as that carrier and only the
-- discord-link payload is dropped. Discord rows are excluded from every
-- socials read, so nothing renders them.

BEGIN;

DELETE FROM creator_socials
 WHERE platform = 'discord'
   AND (reward_page_url IS NULL OR btrim(reward_page_url) = '');

ALTER TABLE creator_socials DROP COLUMN IF EXISTS discord_channel_url;

COMMIT;
