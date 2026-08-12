import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { repositoryFiles } from "./repository-files";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Every column the excluded-users blacklist targets is a `text` user id.
 * `"user".id`, `affiliate_code_usages.affiliate_user_id` and
 * `ledger_transactions.user_id` are all `text().notNull()` in the introspection
 * snapshot, and packy.gg ids are not UUID-shaped.
 *
 * A `::uuid` cast on the bound ids therefore made PostgreSQL fail the ENTIRE
 * query with `42883 operator does not exist: text <> uuid` — verified against
 * the live database — for every non-empty blacklist. `excluded_users` is
 * populated in production, so that took out ~60 insights-rewards read legs at
 * once, before any of them could even reach a query plan.
 *
 * These modules import `server-only`, so they cannot be loaded in a plain node
 * test; this guard is static, matching `postgres-drizzle-boundary.test.ts`.
 */

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

test("the blacklist helper never casts a bound id to uuid", () => {
  const source = read("src/lib/queries/insights-rewards/_drizzle-query.ts");
  const helper = source.slice(source.indexOf("export function blacklistNotInSql"));
  // Strip comments — the explanatory note below names the very cast it forbids.
  const body = helper
    .slice(0, helper.indexOf("\n}"))
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  assert.match(
    body,
    /ids\.map\(\(id\) => sql`\$\{id\}`\)/,
    "ids must be bound as text, exactly as blacklistNotInClause inlines them",
  );
  assert.doesNotMatch(
    body,
    /::uuid/,
    "a ::uuid cast on a text user id fails the whole query with 42883",
  );
});

test("both blacklist helpers still short-circuit on an empty id list", () => {
  // An empty NOT IN () is a 42601 syntax error, so each helper must contribute
  // nothing at all rather than an empty list.
  assert.match(
    read("src/lib/queries/insights-rewards/_drizzle-query.ts"),
    /if \(ids\.length === 0\) return sql\.raw\(""\);/,
  );
  assert.match(
    read("src/lib/queries/_blacklist.ts"),
    /if \(ids\.length === 0\) return "";/,
  );
});

test("the blacklist is only pointed at text user-id columns", () => {
  // If a future call site targets a uuid column, the text binding above would
  // be wrong for it — this pins the reviewed set.
  const allowed = new Set(["u.id", "id", "acu.affiliate_user_id", "lt.user_id"]);
  const columns = new Set<string>();

  for (const file of repositoryFiles({
    root,
    pathspecs: ["src/**/*.ts", "src/**/*.tsx"],
  })) {
    const body = readFileSync(path.join(root, file), "utf8");
    for (const match of body.matchAll(/blacklistNotInSql\(\s*"([^"]+)"/g)) {
      columns.add(match[1]);
    }
  }

  assert.ok(columns.size > 0, "expected to find blacklistNotInSql call sites");
  const unexpected = [...columns].filter((c) => !allowed.has(c));
  assert.deepEqual(
    unexpected,
    [],
    `new blacklist column(s) ${unexpected.join(", ")} — confirm each is a text ` +
      `user id in src/lib/db-schema/main/schema.ts before adding them here`,
  );
});
