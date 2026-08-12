import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * Read-count guardrails for the /admin-users and /system route areas.
 *
 * These pages read the ADMIN pool, which is `max: 4` per serverless instance
 * (src/lib/admin-db.ts) with NO admission control in front of it — excess
 * readers queue inside node-postgres and reject on `connectionTimeoutMillis`
 * with "timeout exceeded when trying to connect", which `safeQuery` reports as
 * a hard failure and the UI renders as "Couldn't load this section". So the
 * thing worth pinning is the SHAPE — how many round trips a render costs and
 * whether the shell can paint before them — not any tuning number.
 *
 * Source is read with `readFileSync` rather than imported: these modules are
 * `server-only` / route entrypoints and pull the pg driver.
 */
const read = (path: string) => readFileSync(path, "utf8");

const ROLE_EDITOR_DATA =
  "src/app/(admin)/admin-users/_roles/role-editor-data.ts";
const ROLES_OVERVIEW_DATA =
  "src/app/(admin)/admin-users/_roles/roles-overview-data.ts";
const DISCORD_PAGE = "src/app/(admin)/system/discord-moderation/page.tsx";

/** Count the `adminDrizzle.execute` round trips in a module's source. */
function executeCount(source: string): number {
  return source.match(/adminDrizzle\s*\.?\s*execute</g)?.length ?? 0;
}

test("the role editor loads one role from ONE Admin-DB statement", () => {
  const source = read(ROLE_EDITOR_DATA);

  // The six per-role limit columns must come from the same statement that
  // already selects the role row. Re-reading them through `getRoleLimits`
  // was a second round trip for columns we were already sitting on.
  assert.ok(
    !/from ["']@\/lib\/role-limits["']/.test(source),
    "role-editor-data must not re-read the role row via getRoleLimits",
  );
  for (const column of [
    "balance_limit_daily",
    "balance_limit_weekly",
    "balance_limit_monthly",
    "issuance_limit_daily",
    "issuance_limit_weekly",
    "issuance_limit_monthly",
  ]) {
    assert.ok(
      source.includes(`r.${column}::text`),
      `${column} must be selected alongside the role row`,
    );
  }

  // A CUSTOM role's "affected users" is the same population as the row read's
  // `COUNT(u.id) … ON u.role_id = r.id`, so it must be reused, never re-counted.
  assert.ok(
    !/WHERE role_id = \$\{id\}::uuid\s*\n?\s*`\)/.test(source),
    "the custom-role affected-user count must reuse holderCount",
  );
  assert.ok(
    /holderCount: number,\s*\)/.test(source),
    "countAffectedUsers must take the already-known holder count",
  );

  // The "Assigned admins" panel is rendered from a role the caller already
  // loaded, so it must be able to skip re-probing is_system/system_key.
  assert.ok(
    /export async function getRoleHolders\([\s\S]*?known\?:/.test(source),
    "getRoleHolders must accept the caller's already-known role identity",
  );
});

test("the roles overview issues its Admin-DB reads in parallel, not in series", () => {
  const source = read(ROLES_OVERVIEW_DATA);

  assert.equal(
    executeCount(source),
    2,
    "getRolesOverview must cost exactly two Admin-DB round trips",
  );
  assert.ok(
    /await Promise\.all\(\[/.test(source),
    "both reads must be issued together",
  );
  // The per-role holder tally is derived in code from the single admin_users
  // read; a second GROUP BY over the same table is the regression to catch.
  assert.ok(
    !/FROM admin_users\s+GROUP BY role/.test(source),
    "the holder tally must not re-scan admin_users with its own GROUP BY",
  );
});

test("/system/discord-moderation paints its shell before the Admin-DB fan-out", () => {
  const source = read(DISCORD_PAGE);

  const body = source.slice(source.indexOf("export default async function"));
  const pageBody = body.slice(0, body.indexOf("\n}"));

  // Only the access gate may be awaited before the shell renders.
  const awaited = pageBody.match(/await [A-Za-z_$][\w$.]*\(/g) ?? [];
  assert.deepEqual(
    awaited,
    ["await requirePageAccess("],
    "the page body must await nothing but the page-access gate",
  );
  assert.ok(
    /<Suspense/.test(source),
    "the data fan-out must stream behind a Suspense boundary",
  );
  assert.ok(
    existsSync("src/app/(admin)/system/discord-moderation/loading.tsx"),
    "the route needs a loading.tsx rendering the same shell",
  );

  // The heaviest, purely read-only leg (the XP stats fan-out) must be fault
  // isolated so it degrades its own panel instead of the whole workspace.
  assert.ok(
    /safeQueryOrNull\(\s*\(\) => getCommunityXpDashboard\(\)/.test(source),
    "the XP dashboard read must be wrapped so it degrades on its own",
  );
});
