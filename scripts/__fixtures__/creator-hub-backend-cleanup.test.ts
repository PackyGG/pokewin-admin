import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");
const hub = "src/app/(creator-hub)/creator-hub";

test("creator hub keeps period KPIs separate from fixed chart scans", () => {
  const overview = read(`${hub}/_queries/dashboard-overview.ts`);
  const cohort = read(`${hub}/_queries/hub-dashboard-cohort.ts`);
  const page = read(`${hub}/page.tsx`);

  assert.match(overview, /getHubCohortKpis\(period\)/);
  assert.doesNotMatch(overview, /getHubCohortWindowed/);
  assert.doesNotMatch(overview, /import \{ getCreatorsGlobalStats \}/);
  assert.match(cohort, /hub-cohort-kpis-v1/);
  assert.match(cohort, /hub-cohort-charts-30d-v1/);
  assert.match(page, /getHubCohortCharts\(\)/);
});

test("creator hub backend walks share bounded pagination and fan-out", () => {
  const helper = read(`${hub}/_lib/backend-walk.ts`);
  assert.match(helper, /export async function pagedWalk/);
  assert.match(helper, /export async function mapPool/);

  for (const path of [
    `${hub}/_queries/four-week-summary.ts`,
    `${hub}/profitability/_queries/deal-profitability.ts`,
    `${hub}/profitability/_queries/past-deals.ts`,
  ]) {
    const source = read(path);
    assert.match(source, /pagedWalk\(/);
    assert.match(source, /mapPool\(/);
    assert.doesNotMatch(source, /Promise\.allSettled\(/);
  }

  assert.match(
    read(`${hub}/leaderboards/_queries/live-leaderboards.ts`),
    /pagedWalk\(/,
  );
  assert.doesNotMatch(
    read(`${hub}/tips-sponsors/_queries/tips-sponsors-data.ts`),
    /async function mapPool/,
  );
});

test("creator hub cleanup preserves truthful money and query contracts", () => {
  const boardPnl = read(
    `${hub}/profitability/_queries/frame-affiliate-pnl-by-board.ts`,
  );
  const rewards = read(`${hub}/rewards/actions.ts`);
  const altAccounts = read(
    `${hub}/creators/[id]/_queries/alt-accounts-data.ts`,
  );
  const risk = read(`${hub}/creators/[id]/_queries/risk-data.ts`);

  assert.match(boardPnl, /queryRowsInTimeboxedTx\(/);
  assert.match(boardPnl, /CREATOR_PNL_STATEMENT_TIMEOUT_MS/);
  assert.match(rewards, /claim\.leg === "ftd_lossback"/);
  assert.match(rewards, /% FTD lossback/);
  assert.match(rewards, /\(\$\{payoutBasis\}\)/);
  assert.equal(
    altAccounts.match(/await enrichMembers\(/g)?.length,
    1,
    "cluster members must be enriched in one batched call",
  );
  assert.match(risk, /const perUserIds = new Set/);
  assert.match(risk, /!perUserIds\.has\(r\.user_id\)/);
});
