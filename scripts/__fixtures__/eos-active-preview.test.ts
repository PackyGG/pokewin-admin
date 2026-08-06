import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { calculateCreatorBattleOutcome } from "../../src/lib/eos/creator-outcome";

test("creator win exposes gross payout and all-in net", () => {
  const result = calculateCreatorBattleOutcome({
    creatorWon: true,
    creatorPaidStake: 75,
    creatorBorrowPercentage: 25,
    sponsorshipAmountPaid: 30,
    totalUnpacked: 400,
    winningTeamSize: 2,
  });

  assert.deepEqual(result, {
    stakeAmount: 75,
    sponsorshipCost: 30,
    payoutAmount: 150,
    netAmount: 45,
  });
});

test("creator loss reports zero payout and the full loss", () => {
  const result = calculateCreatorBattleOutcome({
    creatorWon: false,
    creatorPaidStake: 30,
    creatorBorrowPercentage: 70,
    sponsorshipAmountPaid: 40,
    totalUnpacked: 900,
    winningTeamSize: 2,
  });

  assert.deepEqual(result, {
    stakeAmount: 30,
    sponsorshipCost: 40,
    payoutAmount: 0,
    netAmount: -70,
  });
});

test("unresolved battle never invents an outcome", () => {
  const result = calculateCreatorBattleOutcome({
    creatorWon: null,
    creatorPaidStake: 100,
    creatorBorrowPercentage: 0,
    sponsorshipAmountPaid: 0,
    totalUnpacked: null,
    winningTeamSize: 0,
  });

  assert.equal(result.payoutAmount, null);
  assert.equal(result.netAmount, null);
});

test("live EOS preview is owner-gated and reads only active committed truth", () => {
  const query = readFileSync(
    "src/lib/queries/eos-active-preview.ts",
    "utf8",
  );
  const page = readFileSync(
    "src/app/(admin)/system/eos-verification/page.tsx",
    "utf8",
  );

  assert.match(query, /await requireOwner\(\)/);
  assert.match(page, /await requireOwner\(\)/);
  assert.match(query, /b\.status IN \('waiting', 'in_progress', 'animating'\)/);
  assert.match(query, /b\.winner_team/);
  assert.match(query, /b\.total_unpacked/);
  assert.match(query, /session\.bet_amount AS paid_stake/);
  assert.doesNotMatch(query, /server_seed(?!_hash)/);
  assert.doesNotMatch(query, /PEPPER|decrypt/i);
});
