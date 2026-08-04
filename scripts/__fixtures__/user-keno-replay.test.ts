import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actions = readFileSync(
  "src/app/(admin)/users/[id]/actions.ts",
  "utf8",
);
const modal = readFileSync(
  "src/app/(admin)/users/[id]/transaction-detail-modal.tsx",
  "utf8",
);
const transactions = readFileSync(
  "src/app/(admin)/users/[id]/user-tabs-transactions.tsx",
  "utf8",
);
const transactionQuery = readFileSync(
  "src/lib/queries/users-transactions.ts",
  "utf8",
);
const transactionCache = readFileSync(
  "src/lib/queries/users-detail-cache.ts",
  "utf8",
);
const userPage = readFileSync(
  "src/app/(admin)/users/[id]/page.tsx",
  "utf8",
);
const transactionTypes = readFileSync(
  "src/app/(admin)/users/[id]/user-tabs-types.ts",
  "utf8",
);
const replay = readFileSync(
  "src/app/(admin)/users/[id]/keno-game-replay.tsx",
  "utf8",
);

test("Keno replay lookup is ownership checked and index bounded", () => {
  assert.match(actions, /export async function getKenoGameDetails/);
  assert.match(actions, /await requirePageAccess\("\/users"\)/);
  assert.match(actions, /AND user_id = \$\{userId\}/);
  assert.match(actions, /type::text IN \('keno_bet', 'keno_payout'\)/);
  assert.match(actions, /kg\.created_at >= tx\.created_at - INTERVAL '1 day'/);
  assert.match(actions, /kg\.bet_ledger_tx_id = tx\.id/);
  assert.match(actions, /kg\.payout_ledger_tx_id = tx\.id/);
});

test("Keno transaction modal lazy loads the visual replay", () => {
  assert.match(transactions, /onClick=\{\(\) => \{[\s\S]*setSelectedTx\(t\)/);
  assert.match(modal, /getKenoGameDetails\(kenoTxId, userId\)/);
  assert.match(modal, /<KenoGameReplay game=\{kenoGame\} \/>/);
  assert.match(modal, /t\.type === "keno_bet" \|\| t\.type === "keno_payout"/);
});

test("Keno replay renders all 40 tiles and the hit state", () => {
  assert.match(replay, /Array\.from\(\{ length: 40 \}/);
  assert.match(replay, /const wasHit = wasSelected && wasDrawn/);
  assert.match(replay, /Picked \+ hit/);
  assert.match(replay, /stored position \$\{number\}/);
});

test("Keno replay shows the canonical exact-hit chance", () => {
  assert.match(replay, /getKenoHitProbability\(/);
  assert.match(replay, /formatKenoProbability\(hitProbability\)/);
  assert.match(replay, /label=\{`Chance of \$\{game\.hits\} hits`\}/);
});

test("Gaming shows one settled outcome row per Keno game", () => {
  assert.match(transactionQuery, /fetchKenoSummariesByLedgerId/);
  assert.match(transactionQuery, /requested_tx AS MATERIALIZED/);
  assert.match(transactionQuery, /kg\.created_at >= tx\.created_at - INTERVAL '1 day'/);
  assert.match(transactionQuery, /kg\.bet_ledger_tx_id = tx\.id/);
  assert.match(transactionQuery, /kg\.payout_ledger_tx_id = tx\.id/);
  assert.match(transactionCache, /users-detail-gaming-tx-v6/);
  assert.doesNotMatch(transactions, /label: "User won"/);
  assert.doesNotMatch(transactions, /label: "User lost"/);
  assert.doesNotMatch(transactions, /gamingOutcomeRowClass/);
  assert.doesNotMatch(transactions, /GamingOutcomeBadge/);
  assert.match(
    transactions,
    /t\.type === "keno_bet"[\s\S]*profit=\{t\.amount - t\.kenoWinnings\}[\s\S]*won=\{t\.kenoWinnings\}/,
  );
  assert.match(transactions, /t\.kenoResult === "win"[\s\S]*\? "Won"/);
  assert.match(transactions, /t\.kenoResult === "lose"[\s\S]*\? "Lost"/);
  assert.doesNotMatch(transactions, /\{t\.kenoHits\}\/\{t\.kenoPicks\} hits/);

  const initialTypes = userPage.match(
    /const GAMING_TYPES = \[([\s\S]*?)\n\];/,
  )?.[1];
  const paginatedTypes = transactionTypes.match(
    /export const GAMING_TX_TYPES = \[([\s\S]*?)\n\] as const;/,
  )?.[1];
  assert.ok(initialTypes);
  assert.ok(paginatedTypes);
  assert.match(initialTypes, /"keno_bet"/);
  assert.match(paginatedTypes, /"keno_bet"/);
  assert.doesNotMatch(initialTypes, /"keno_payout"/);
  assert.doesNotMatch(paginatedTypes, /"keno_payout"/);
});
