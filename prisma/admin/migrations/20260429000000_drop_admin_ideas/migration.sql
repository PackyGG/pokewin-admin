-- Ideas board removed. The /ideas route, actions, queries, model, and
-- sidebar entry were all deleted; this table + its FK on admin_users
-- are no longer referenced by any code.

DROP TABLE IF EXISTS "admin_ideas" CASCADE;
