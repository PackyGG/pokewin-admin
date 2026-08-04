import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repoRoot = process.cwd();
const source = (path: string) => readFileSync(`${repoRoot}/${path}`, "utf8");

test("Security exposes all three active Keno wager weights", () => {
  const withdrawal = source(
    "src/app/(admin)/security/wager-requirement-card.tsx",
  );
  const leaderboard = source(
    "src/app/(admin)/security/leaderboard-wager-weights-card.tsx",
  );
  const rakeback = source(
    "src/app/(admin)/security/rakeback-wager-weights-card.tsx",
  );

  assert.match(withdrawal, /key: "wager_weight_keno_bps"/);
  assert.match(withdrawal, /label: "Keno wager weight"/);
  assert.match(leaderboard, /key: "keno_bps"[\s\S]*label: "Keno weight"/);
  assert.match(rakeback, /key: "keno_bps"[\s\S]*label: "Keno weight"/);
});

test("Security Keno controls keep the existing validated backend write paths", () => {
  const withdrawalAction = source(
    "src/app/(admin)/security/wager-requirement-actions.ts",
  );
  const leaderboardAction = source(
    "src/app/(admin)/security/leaderboard-wager-weights-actions.ts",
  );
  const rakebackAction = source(
    "src/app/(admin)/security/rakeback-wager-weights-actions.ts",
  );

  for (const action of [withdrawalAction, leaderboardAction, rakebackAction]) {
    assert.match(action, /requirePageAccess\("\/security"\)/);
    assert.match(action, /requireAdmin\(\)/);
    assert.match(action, /revalidateTag\(SECURITY_CACHE_TAG\)/);
  }

  assert.match(withdrawalAction, /wager_weight_keno_bps: Bps\.optional\(\)/);
  assert.match(leaderboardAction, /keno_bps: Bps\.optional\(\)/);
  assert.match(rakebackAction, /keno_bps: Bps\.optional\(\)/);
});

test("Multiplier tiers remain upgrader-only and explicitly exclude Keno", () => {
  const card = source(
    "src/app/(admin)/security/multiplier-wager-weights-card.tsx",
  );

  assert.match(card, /Only upgrader bets have a player-chosen payout multiplier/);
  assert.match(card, /Packs,[\s\S]*battles, and Keno do not use these tiers/);
});
