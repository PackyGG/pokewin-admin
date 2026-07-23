-- Rollback for 2026-07-23_chat_raffle.up.sql.
--
-- DESTRUCTIVE: drops every raffle round, prize, frozen entry snapshot and
-- manual point adjustment. Balance payouts already made are NOT affected —
-- those live on the main-DB ledger and stay there.
DROP TABLE IF EXISTS "chat_raffle_adjustments";
DROP TABLE IF EXISTS "chat_raffle_entries";
DROP TABLE IF EXISTS "chat_raffle_prizes";
DROP TABLE IF EXISTS "chat_raffle_rounds";

-- Put the permission token back.
UPDATE "admin_users"
   SET "allowed_pages" = array_replace("allowed_pages", '/chat-raffle', '/top-chatters')
 WHERE '/chat-raffle' = ANY("allowed_pages");

UPDATE "admin_users"
   SET "permission_grants" = array_replace("permission_grants", '/chat-raffle', '/top-chatters')
 WHERE '/chat-raffle' = ANY("permission_grants");

UPDATE "admin_users"
   SET "permission_revokes" = array_replace("permission_revokes", '/chat-raffle', '/top-chatters')
 WHERE '/chat-raffle' = ANY("permission_revokes");

UPDATE "admin_roles"
   SET "capabilities" = array_replace("capabilities", '/chat-raffle', '/top-chatters')
 WHERE '/chat-raffle' = ANY("capabilities");
