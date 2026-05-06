-- Grant `__can_update_pack` to every existing admin_user with role
-- 'pack_creator' so they can iterate on demo packs after pressing
-- Save. The default for newly-created pack_creator users already
-- includes this capability (src/app/(admin)/admin-users/actions.ts);
-- this migration back-fills the existing rows.
--
-- Idempotent: array_append-with-NOT-IN check means the cap is added
-- exactly once per user even if the migration re-runs. No effect on
-- pack_creators who already have the capability or on any other role.
--
-- Server-side, updatePack still refuses to touch active=true packs
-- when session.role = 'pack_creator', so the capability alone can't
-- let pack_creators edit live packs — see src/app/(admin)/packs/actions.ts.

UPDATE "admin_users"
   SET "allowed_pages" = array_append("allowed_pages", '__can_update_pack')
 WHERE role = 'pack_creator'
   AND NOT ('__can_update_pack' = ANY("allowed_pages"));
