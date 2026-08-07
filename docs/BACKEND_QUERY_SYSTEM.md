# Backend Query System

## Current MAIN routing

All ordinary MAIN reads use `MIRROR_PRODUCTION_DB` / `MIRROR_DEV_DB` through
the explicit read resolvers in `src/lib/db.ts`. Those pools force read-only
sessions and never fall back to a primary. Existing application mutations use
the explicit primary resolvers backed by `DATABASE_URL` / `DEV_DATABASE_URL`.
Agents may apply concurrent indexes to mirrors only with
`npm run db:index:mirrors -- <prod|dev|all>`.

All database access in `pokewin-admin` targets PostgreSQL. Drizzle ORM is the
default access layer. Use parameterized Drizzle `sql` for complex aggregates
when it produces clearer SQL or a better execution plan.

## Database boundaries

- MAIN contains game and user data. It is production and strictly read-only
  from this repository.
- ADMIN contains admin-panel data. It may be read and written. Schema changes
  use reviewed SQL under `drizzle/admin/migrations`, followed by Drizzle
  introspection.
- Never join across the two databases. Fetch each side once, batch identifiers,
  and merge in application code.
- Runtime pools stay small in serverless deployments. Do not increase pool
  limits to hide slow queries or excessive fan-out.

## Query requirements

Every read must satisfy these rules:

1. Prefer the Drizzle query builder for typed CRUD and ordinary joins.
2. Use `sql` with bound parameters for complex or performance-critical SQL.
   Never interpolate request values, filters, dates, IDs, search text, sort
   expressions, or pagination values into SQL strings.
3. Select only the columns the caller uses.
4. Batch relation lookups. Do not issue one query per result row.
5. Paginate lists server-side with a bounded page size. Prefer keyset
   pagination for hot, frequently changing feeds; offset pagination is
   acceptable for stable admin lists that need random page access.
6. Bound analytics windows. Lifetime reads use the canonical capped lookback
   unless the API contract explicitly requires a money-exact all-time value.
7. Collapse duplicate reads and repeated calculations within a render.
8. Use Decimal-safe database arithmetic and existing money conversion helpers.
9. Keep multi-step money or state mutations in one transaction. Do not hold a
   transaction open while calling external services.

## Index policy

Use read-only `EXPLAIN (ANALYZE, BUFFERS)` against MAIN to verify real query
plans. A selective production query should normally use a suitable index. A
sequential scan is acceptable only when the planner correctly chooses it for a
small table or low-selectivity full aggregate, and that reason is documented.

MAIN remains read-only. Required DDL is recorded as idempotent
`CREATE INDEX CONCURRENTLY IF NOT EXISTS` statements in
`prisma/recommended-indexes.sql` for the owner to apply. Choose index columns
from actual predicates and ordering:

- equality columns first, then range/order columns;
- partial indexes for stable predicates that materially reduce the index;
- `INCLUDE` columns only when they make a frequent hot read covering;
- expression indexes only when the query uses the identical expression.

Do not add speculative or duplicate indexes. Account for write amplification
and check existing primary, unique, and composite indexes first.

## Caching and concurrency

- Resolve request-specific database environment state before entering
  `unstable_cache`.
- Cache production analytics and read-mostly aggregates. Do not cache live
  mutation-sensitive admin lists.
- Include every period, scope, blacklist, and behavior-affecting option in the
  cache key. Bump the cache version when query shape or math changes.
- Invalidate both the route and relevant cache tags after ADMIN mutations.
- Use `safeQuery` timeouts for heavy reads so one slow query cannot block a
  route indefinitely.
- Avoid wide `Promise.all` fan-out against the small pool. Combine compatible
  aggregates into one SQL statement or run bounded groups.

## Rendering rules

Pages render the static shell and controls first. Heavy reads live in async
children behind focused `Suspense` boundaries with matching skeletons.

Only the active tab and active time window may load. Hidden tabs, drawers,
modals, and alternative periods remain lazy. Summary boundaries must not re-key
on pagination or filters they do not depend on.

## Verification

For database changes:

- run `npx tsc --noEmit`;
- run `npm run lint`;
- run `npm run build` when imports, exports, dependencies, routes, schema
  generation, or Server/Client data boundaries changed;
- run relevant unit and integration tests;
- inspect affected consumers after shared query changes;
- verify important plans with read-only PostgreSQL `EXPLAIN`.

Never execute direct DDL or ad-hoc data mutations on primary MAIN connections.
Index DDL is allowed on `MIRROR_PRODUCTION_DB` / `MIRROR_DEV_DB` only.
