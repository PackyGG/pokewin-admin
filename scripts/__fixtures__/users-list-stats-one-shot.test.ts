import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(
  path.join(process.cwd(), "src/lib/queries/users-list.ts"),
  "utf8",
);

test("users-list stats cache fills use one MAIN pool slot", () => {
  const start = source.indexOf("const cachedUsersListStats = unstable_cache(");
  const end = source.indexOf(
    "export async function getUsersListStats()",
    start,
  );
  assert.ok(start >= 0 && end > start, "cachedUsersListStats source block missing");

  const block = source.slice(start, end);
  assert.equal(
    block.match(/queryMainRows</g)?.length,
    1,
    "users-list stats must stay a single PostgreSQL statement",
  );
  assert.doesNotMatch(block, /Promise\.all\(/);
  assert.match(block, /WITH user_stats AS \(/);
  assert.match(block, /depositor_stats AS \(/);
  assert.match(block, /ftd_stats AS \(/);
  assert.match(source, /users-list-stats-v4-one-shot/);
});
