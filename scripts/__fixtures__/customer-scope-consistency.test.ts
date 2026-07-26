import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

const canonicalRoles = /role NOT IN \('admin', 'support', 'creator'\)/;

test("race overview and rakeback lapsed use canonical customer roles", () => {
  for (const relative of [
    "src/lib/queries/insights-rewards/race/overview.ts",
    "src/lib/queries/insights-rewards/rakeback/lapsed.ts",
  ]) {
    const source = read(relative);
    assert.ok(
      (source.match(new RegExp(canonicalRoles.source, "g"))?.length ?? 0) >= 2,
      `${relative} must apply the canonical role scope to both query legs`,
    );
    assert.doesNotMatch(source, /role NOT IN \('admin', 'support'\)/);
  }
});

test("battle stats use canonical roles and the dynamic blacklist", () => {
  const source = read("src/lib/queries/analytics.ts");

  assert.equal(
    source.match(/const battleCustomerIds = /g)?.length,
    2,
    "both analytics bundles must define the same battle customer scope",
  );
  assert.match(source, canonicalRoles);
  assert.match(source, /\$\{blacklistIdNotIn\}/);
  assert.doesNotMatch(source, /role != 'admin'/);
});

test("creator referral analytics exclude creator-role referrals", () => {
  const source = read("src/lib/queries/creators-analytics.ts");

  assert.match(source, canonicalRoles);
  assert.match(source, /blacklistNotInClause\("id", excluded\)/);
  assert.match(source, /referred_user_id IN \$\{referredScope\}/);
  assert.doesNotMatch(source, /realCustomerIdsSubquery/);
});

test("deposit-bonus shared scope excludes creators", () => {
  const source = read(
    "src/lib/queries/insights-rewards/deposit-bonus/_shared.ts",
  );

  assert.match(source, canonicalRoles);
  assert.doesNotMatch(
    source,
    /return sql`\(SELECT id FROM "user" WHERE role NOT IN \('admin', 'support'\)/,
  );
});

test("deposit-bonus inline scopes exclude creators surface-wide", () => {
  for (const relative of [
    "src/lib/queries/insights-rewards/deposit-bonus/geo-source.ts",
    "src/lib/queries/insights-rewards/deposit-bonus/top-spenders.ts",
    "src/lib/queries/insights-rewards/deposit-bonus/impact.ts",
  ]) {
    const source = read(relative);
    assert.match(source, canonicalRoles);
    assert.doesNotMatch(source, /u\.role NOT IN \('admin', 'support'\)/);
  }
});
