import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("wager progress prioritizes withdrawal access without changing debt semantics", async () => {
  const card = await readFile(
    "src/app/(admin)/users/[id]/user-wager-progress-card.tsx",
    "utf8",
  );

  assert.match(card, /Withdrawal access/);
  assert.match(card, /Current balance access/);
  assert.match(card, /Math\.min\(remainingUsd, availableBalanceUsd\)/);
  assert.match(card, /Debt exceeds balance by/);
  assert.match(card, /Lifetime weighted wager/);
  assert.match(card, /These do not[\s\S]*add up to the wager debt above/);
  assert.match(card, /<details/);
  assert.match(card, /sm:hidden/);
  assert.match(card, /hidden overflow-x-auto sm:block/);

  assert.match(card, /canManage &&/);
  assert.match(card, /setUserWagerRemainingAction/);
  assert.match(card, /refreshUserWagerProgressAction/);
  assert.match(card, /setLocalData\(fresh\)/);
  assert.doesNotMatch(card, /from ["']next\/navigation["']/);
  assert.doesNotMatch(card, /router\.refresh\(\);/);
});
