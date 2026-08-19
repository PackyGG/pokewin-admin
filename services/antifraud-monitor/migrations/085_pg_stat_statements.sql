-- Railway's PostgreSQL image already preloads pg_stat_statements. Expose the
-- per-statement counters in this database so query and temporary-file tuning
-- can be based on measured statements instead of global cumulative totals.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
