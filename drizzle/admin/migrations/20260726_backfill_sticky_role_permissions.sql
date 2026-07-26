WITH role_defaults(role_key, role_ord, tokens) AS (
  VALUES
    (
      'support',
      1,
      ARRAY[
        '/users',
        '/dashboard'
      ]::text[]
    ),
    (
      'pack_creator',
      2,
      ARRAY[
        '/packs',
        '/cards',
        '/sets',
        '/upgrader',
        '__can_create_pack',
        '__can_update_pack',
        '__can_edit_live_packs',
        '__can_upload_pack_image',
        '__can_create_card',
        '__can_update_card',
        '__can_delete_card',
        '__can_upload_card_image',
        '__can_create_set',
        '__can_delete_pack',
        '__can_toggle_pack_active',
        '__can_update_set',
        '__can_delete_set',
        '__can_seed_initial_sets',
        '__can_force_absorb_cards',
        '__can_upload_set_image',
        '__can_add_upgrader_output',
        '__can_toggle_upgrader_output',
        '__can_remove_upgrader_output'
      ]::text[]
    )
),
defaults AS (
  SELECT rd.role_key, rd.role_ord, token, token_ord
  FROM role_defaults rd
  CROSS JOIN LATERAL unnest(rd.tokens)
    WITH ORDINALITY AS expanded(token, token_ord)
)
UPDATE admin_users au
SET allowed_pages =
  au.allowed_pages
  || ARRAY(
    SELECT d.token
    FROM defaults d
    WHERE (
        au.role::text = d.role_key
        OR EXISTS (
          SELECT 1
          FROM unnest(au.roles) AS assigned(role_key)
          WHERE assigned.role_key::text = d.role_key
        )
      )
      AND NOT (d.token = ANY(au.allowed_pages))
    GROUP BY d.token
    ORDER BY min(d.role_ord), min(d.token_ord)
  )
WHERE EXISTS (
  SELECT 1
  FROM defaults d
  WHERE (
      au.role::text = d.role_key
      OR EXISTS (
        SELECT 1
        FROM unnest(au.roles) AS assigned(role_key)
        WHERE assigned.role_key::text = d.role_key
      )
    )
    AND NOT (d.token = ANY(au.allowed_pages))
);
