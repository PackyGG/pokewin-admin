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

  // The Overview bundle dropped its `battleStats` leg (never rendered — see the
  // `analytics-data-v3` cache note), so there is no second `battleCustomerIds`
  // left to compare against. The old `=== 2` was never about the count: it was
  // there so no bundle could roll its own, weaker battle scope. Pin that
  // directly — at least one definition must exist, and EVERY definition that
  // exists must be canonical roles + the dynamic blacklist.
  const scopeDefinitions = source.match(/const battleCustomerIds = .*/g) ?? [];
  assert.ok(
    scopeDefinitions.length >= 1,
    "analytics.ts must still define the battle customer scope",
  );
  for (const definition of scopeDefinitions) {
    assert.match(
      definition,
      canonicalRoles,
      `battle customer scope is not canonical: ${definition}`,
    );
    assert.match(
      definition,
      /\$\{blacklistIdNotIn\}/,
      `battle customer scope drops the dynamic blacklist: ${definition}`,
    );
  }

  // …and every `battles` scan must go through that shared scope rather than an
  // unscoped WHERE of its own. This is what "battle stats use canonical roles"
  // means at the query level, and it is what the two-bundle comparison was
  // standing in for.
  assert.match(
    source,
    /const battleStaffExcl = `user_id IN \$\{battleCustomerIds\}`/,
  );
  assert.match(
    source,
    /const battleStaffExclAliased = `b\.user_id IN \$\{battleCustomerIds\}`/,
  );
  const battleScans = source.match(/FROM battles\b/g)?.length ?? 0;
  const scopedWheres =
    source.match(/\$\{battleDateWhere(?:Aliased)?\}/g)?.length ?? 0;
  assert.ok(battleScans > 0, "analytics.ts must still read the battles table");
  assert.equal(
    scopedWheres,
    battleScans,
    "every battles scan must carry the scoped WHERE built from battleCustomerIds",
  );

  assert.match(source, canonicalRoles);
  assert.match(source, /\$\{blacklistIdNotIn\}/);
  assert.doesNotMatch(source, /role != 'admin'/);
  assert.doesNotMatch(source, /role NOT IN \('admin', 'support'\)/);
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
