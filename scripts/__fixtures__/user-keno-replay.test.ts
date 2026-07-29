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

test("Gaming rows expose settled Keno outcomes with house-POV colors", () => {
  assert.match(transactionQuery, /fetchKenoSummariesByLedgerId/);
  assert.match(transactionQuery, /kg\.created_at >= \$\{minCreatedAt\}/);
  assert.match(transactionQuery, /requested\.id = kg\.bet_ledger_tx_id/);
  assert.match(transactionQuery, /requested\.id = kg\.payout_ledger_tx_id/);
  assert.match(transactions, /label: "User won"/);
  assert.match(transactions, /label: "User lost"/);
  assert.match(transactions, /border-l-rose-500/);
  assert.match(transactions, /border-l-emerald-500/);
  assert.match(transactions, /t\.kenoHits.*t\.kenoPicks/s);
});
