-- Pack Builder owns only Pack Studio plus the Packs, Cards, and Sets catalogs.
-- Reconcile the system-role template and every dedicated holder in one pass.
WITH canonical(capabilities) AS (
  VALUES (ARRAY[
    '/packs',
    '/cards',
    '/sets',
    '__can_create_pack',
    '__can_update_pack',
    '__can_delete_pack',
    '__can_toggle_pack_active',
    '__can_edit_live_packs',
    '__can_upload_pack_image',
    '__can_create_card',
    '__can_update_card',
    '__can_delete_card',
    '__can_upload_card_image',
    '__can_create_set',
    '__can_update_set',
    '__can_delete_set',
    '__can_seed_initial_sets',
    '__can_force_absorb_cards',
    '__can_upload_set_image'
  ]::text[])
)
UPDATE admin_roles AS role
SET capabilities = canonical.capabilities,
    updated_at = NOW()
FROM canonical
WHERE role.system_key = 'pack_creator'::admin_role
  AND role.capabilities IS DISTINCT FROM canonical.capabilities;

WITH canonical(capabilities) AS (
  VALUES (ARRAY[
    '/packs',
    '/cards',
    '/sets',
    '__can_create_pack',
    '__can_update_pack',
    '__can_delete_pack',
    '__can_toggle_pack_active',
    '__can_edit_live_packs',
    '__can_upload_pack_image',
    '__can_create_card',
    '__can_update_card',
    '__can_delete_card',
    '__can_upload_card_image',
    '__can_create_set',
    '__can_update_set',
    '__can_delete_set',
    '__can_seed_initial_sets',
    '__can_force_absorb_cards',
    '__can_upload_set_image'
  ]::text[])
)
UPDATE admin_users AS admin
SET allowed_pages = canonical.capabilities,
    permission_grants = ARRAY[]::text[],
    permission_revokes = ARRAY[]::text[],
    updated_at = NOW(),
    sessions_valid_after = NOW()
FROM canonical
WHERE admin.role = 'pack_creator'::admin_role
  AND (
    cardinality(admin.roles) = 0
    OR admin.roles <@ ARRAY['pack_creator'::admin_role]
  )
  AND (
    admin.allowed_pages IS DISTINCT FROM canonical.capabilities
    OR cardinality(admin.permission_grants) > 0
    OR cardinality(admin.permission_revokes) > 0
  );

-- The retired Shards route is removed from every account.
UPDATE admin_users
SET allowed_pages = array_remove(allowed_pages, '/rewards/shards'),
    permission_grants = array_remove(permission_grants, '/rewards/shards'),
    permission_revokes = array_remove(permission_revokes, '/rewards/shards'),
    updated_at = NOW()
WHERE '/rewards/shards' = ANY(allowed_pages)
   OR '/rewards/shards' = ANY(permission_grants)
   OR '/rewards/shards' = ANY(permission_revokes);

-- Multi-role Pack Builders keep permissions supplied by their other jobs, but
-- no longer inherit the Upgrader surface from the Pack Builder role.
WITH retired(token) AS (
  SELECT unnest(ARRAY[
    '/upgrader',
    '__can_add_upgrader_output',
    '__can_toggle_upgrader_output',
    '__can_remove_upgrader_output'
  ]::text[])
)
UPDATE admin_users
SET allowed_pages = ARRAY(
      SELECT token
      FROM unnest(allowed_pages) WITH ORDINALITY AS current(token, ord)
      WHERE token NOT IN (SELECT retired.token FROM retired)
      ORDER BY ord
    ),
    permission_grants = ARRAY(
      SELECT token
      FROM unnest(permission_grants) WITH ORDINALITY AS current(token, ord)
      WHERE token NOT IN (SELECT retired.token FROM retired)
      ORDER BY ord
    ),
    permission_revokes = ARRAY(
      SELECT token
      FROM unnest(permission_revokes) WITH ORDINALITY AS current(token, ord)
      WHERE token NOT IN (SELECT retired.token FROM retired)
      ORDER BY ord
    ),
    updated_at = NOW()
WHERE role = 'pack_creator'::admin_role
   OR 'pack_creator'::admin_role = ANY(roles);
