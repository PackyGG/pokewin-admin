-- Additive multi-role support for admin_users.
--
-- Adds a `roles admin_role[]` column so a single admin user can hold
-- several system roles at once (e.g. support + pack_creator). The
-- existing singular `role` column is KEPT as the canonical/primary
-- field — every legacy code path that reads `role` keeps working. The
-- effective role set is `roles` when it is non-empty, otherwise `[role]`
-- (see getEffectiveRoles in src/lib/admin-roles.ts).
--
-- Backward-compat: every existing row is back-filled so `roles` contains
-- exactly its current `role`. This keeps the DB state self-consistent
-- (roles always reflects role) without changing any user's effective
-- access — a single-role user ends up with a single-element array, which
-- is identical to the legacy `[role]` interpretation.
--
-- Pure additive change. No column is dropped, no enum value removed, no
-- effective permission changes for any existing user.

ALTER TABLE "admin_users"
  ADD COLUMN IF NOT EXISTS "roles" "admin_role"[] NOT NULL DEFAULT ARRAY[]::"admin_role"[];

-- Back-fill existing rows: roles := [role] wherever roles is still empty.
UPDATE "admin_users"
   SET "roles" = ARRAY["role"]
 WHERE cardinality("roles") = 0;
