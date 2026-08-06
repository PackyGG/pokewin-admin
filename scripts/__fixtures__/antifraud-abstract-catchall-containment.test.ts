import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("validated catch-all containment target is pure and apply bans without KYC", () => {
  const helper = read("src/lib/antifraud/abstract-catchall-containment.ts");

  assert.match(helper, /export function abstractCatchallContainmentTarget/);
  assert.match(helper, /export async function applyAbstractCatchallContainment/);
  assert.match(helper, /containmentRequired !== true/);
  assert.match(helper, /provider !== "abstract_email"/);
  assert.match(helper, /emailDomain/);
  assert.match(helper, /Abstract-confirmed catch-all/);

  const targetFn = helper.slice(
    helper.indexOf("export function abstractCatchallContainmentTarget"),
    helper.indexOf("export async function applyAbstractCatchallContainment"),
  );
  assert.doesNotMatch(targetFn, /getProdPrimaryDrizzleDb/);
  assert.doesNotMatch(targetFn, /db\.execute|db\.transaction/);

  assert.match(helper, /is_banned = TRUE/);
  assert.match(helper, /DELETE FROM session/);
  assert.doesNotMatch(helper, /requireUserKyc|getUserKyc/);
  assert.match(helper, /return banned \? "banned" : "skipped"/);
});
