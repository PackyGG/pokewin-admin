UPDATE admin_roles
SET name = 'Pack Builder',
    description = 'Dedicated Packs-webapp role for building and managing packs and cards.',
    updated_at = NOW()
WHERE system_key = 'pack_creator'::admin_role
  AND (
    name IS DISTINCT FROM 'Pack Builder'
    OR description IS DISTINCT FROM 'Dedicated Packs-webapp role for building and managing packs and cards.'
  );
