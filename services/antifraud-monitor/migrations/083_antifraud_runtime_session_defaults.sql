-- PgBouncer transaction mode rejects arbitrary PostgreSQL startup parameters.
-- Put the runtime safeguards on the database role instead, so every backend
-- session receives them whether clients connect directly or through the pool.
-- migrate.ts explicitly disables statement_timeout on its dedicated direct
-- connection while it holds the migration lock.
DO $migration$
DECLARE
    database_name text := current_database();
    role_name text := current_user;
BEGIN
    EXECUTE format(
        'ALTER ROLE %I IN DATABASE %I SET statement_timeout TO %L',
        role_name,
        database_name,
        '15s'
    );
    EXECUTE format(
        'ALTER ROLE %I IN DATABASE %I SET TimeZone TO %L',
        role_name,
        database_name,
        'UTC'
    );
    -- The poller holds a transaction-scoped leader lease idle while its phases
    -- run on other clients. Reaping that transaction would release leadership
    -- early and allow duplicate containment work on another replica.
    EXECUTE format(
        'ALTER ROLE %I IN DATABASE %I SET idle_in_transaction_session_timeout TO %L',
        role_name,
        database_name,
        '0'
    );
END
$migration$;
