import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = "src/app/(antifraud)/antifraud/page.tsx";
const queryPath = "src/lib/antifraud/overview.ts";
const loadingPath = "src/app/(antifraud)/antifraud/loading.tsx";
const panelsPath =
  "src/app/(antifraud)/antifraud/_components/overview-panels.tsx";

test("fraud overview renders the complete owner KPI and chart contract", async () => {
  const [page, loading, panels] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(loadingPath, "utf8"),
    readFile(panelsPath, "utf8"),
  ]);

  for (const label of [
    "Fiat deposits",
    "KYC locked",
    "Banned",
    "Signup reviews left",
    "Fiat reviews left",
    "Auto-lock reviews left",
  ]) {
    assert.match(page, new RegExp(label));
  }
  for (const splitLabel of [
    "Legitimate",
    "Fraud",
    "Manual",
    "System",
    "Automatic",
  ]) {
    assert.match(page, new RegExp(splitLabel));
  }
  assert.match(page, /xl:grid-cols-6/);
  assert.match(loading, /Array\.from\(\{ length: 6 \}/);
  assert.match(panels, /Fiat deposits/);
  assert.match(panels, /Accounts/);
  assert.match(panels, /30 days/);
  assert.match(panels, /OverviewActionFeed/);
  assert.match(page, /PanelErrorBoundary/);
});

test("overview metrics use bounded real sources and never equate KYC with fraud", async () => {
  const query = await readFile(queryPath, "utf8");

  assert.match(query, /pwe\.event_type = 'payment\.succeeded'/);
  assert.match(query, /DISTINCT ON \(payment_id\)/);
  assert.match(query, /automaticBanSql/);
  assert.match(query, /Automatic fraud ban:/);
  assert.match(query, /kyc_required_by LIKE 'system:%'/);
  assert.match(query, /SELECT generate_series\([\s\S]*interval '29 days'/);
  assert.match(query, /interval '30 days'/);
  assert.match(query, /LIMIT 24/);
  assert.match(query, /unstable_cache\(/);
  assert.match(query, /revalidate: 60/);
  assert.match(query, /antifraud-overview-dashboard-v4/);
  assert.doesNotMatch(
    query,
    /fraud[\s\S]{0,120}user_kyc\.kyc_required\s*=\s*TRUE/i,
  );
});
