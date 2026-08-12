import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = "src/app/(antifraud)/antifraud/page.tsx";
const queryPath = "src/lib/antifraud/overview.ts";
const loadingPath = "src/app/(antifraud)/antifraud/loading.tsx";
const panelsPath =
  "src/app/(antifraud)/antifraud/_components/overview-panels.tsx";
// Recharts lives in its own module so the action feed can hydrate (and open
// its SSE stream) without waiting on the chart bundle.
const chartsPath =
  "src/app/(antifraud)/antifraud/_components/overview-charts.tsx";
// The lazy boundary has to sit in a client module: `next/dynamic` called from
// a Server Component leaves Recharts in the page's initial chunk group
// (measured — /antifraud First Load JS was unchanged at 448 kB, and dropped to
// 334 kB once the boundary moved here).
const chartsLazyPath =
  "src/app/(antifraud)/antifraud/_components/overview-charts-lazy.tsx";

test("fraud overview renders the complete owner KPI and chart contract", async () => {
  const [page, loading, panels, charts, chartsLazy] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(loadingPath, "utf8"),
    readFile(panelsPath, "utf8"),
    readFile(chartsPath, "utf8"),
    readFile(chartsLazyPath, "utf8"),
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
  assert.match(charts, /Fiat deposits/);
  assert.match(charts, /Accounts/);
  assert.match(charts, /30 days/);
  assert.match(
    charts,
    /accountDays = days\.filter\(\(day\) => day\.date !== "2026-07-22"\)/,
  );
  assert.match(charts, /<LineChart[\s\S]*data=\{accountDays\}/);
  assert.match(panels, /OverviewActionFeed/);
  // The split is the point: no chart library may creep back into the feed
  // module or straight into the page, the lazy boundary must stay a client
  // module, and the charts must stay server-rendered (never `ssr: false`).
  assert.doesNotMatch(panels, /from "recharts"/);
  assert.doesNotMatch(page, /from "recharts"/);
  assert.match(page, /from "\.\/_components\/overview-charts-lazy"/);
  assert.match(chartsLazy, /^"use client";/);
  assert.match(chartsLazy, /dynamic\(\s*\(\) => import\("\.\/overview-charts"\)/);
  assert.doesNotMatch(chartsLazy, /ssr:\s*false/);
  assert.match(page, /PanelErrorBoundary/);
});

test("overview metrics use bounded real sources and never equate KYC with fraud", async () => {
  const query = await readFile(queryPath, "utf8");

  assert.match(query, /pwe\.event_type = 'payment\.succeeded'/);
  assert.match(query, /DISTINCT ON \(payment_id\)/);
  assert.match(query, /automaticBanSql/);
  assert.match(query, /COALESCE\(u\.banned_reason LIKE/);
  assert.match(query, /Automatic % ban:/);
  assert.match(query, /WHERE is_banned AND NOT \$\{automaticBanSql\(\)\}/);
  assert.match(query, /WHERE is_banned AND \$\{automaticBanSql\(\)\}/);
  assert.match(query, /kyc_required_by LIKE 'system:%'/);
  assert.match(query, /SELECT generate_series\([\s\S]*interval '29 days'/);
  assert.match(query, /interval '30 days'/);
  assert.match(query, /LIMIT 24/);
  assert.match(query, /unstable_cache\(/);
  assert.match(query, /revalidate: 60/);
  assert.match(query, /getAntifraudMonitorOverview/);
  assert.match(query, /canonical\.lifetimeCents/);
  // v7: the counters statement was split away from the lifetime fiat scan, so
  // the cached return shape changed and the key had to be bumped. The lifetime
  // scan now has its own key and only runs when the monitor cannot supply the
  // fiat split.
  assert.match(query, /antifraud-overview-dashboard-v7/);
  assert.match(query, /antifraud-overview-mirror-fiat-v1/);
  assert.doesNotMatch(
    query,
    /fraud[\s\S]{0,120}user_kyc\.kyc_required\s*=\s*TRUE/i,
  );
});

test("the dashboard omits ingestion health and both retired status strips", async () => {
  const page = await readFile(pagePath, "utf8");

  assert.doesNotMatch(page, /getAntifraudPollerHealth|poller-health/);
  assert.doesNotMatch(page, /Ingestion healthy|lastSuccessfulTickAt/);
  assert.doesNotMatch(page, /Antifraud activity in the last 24 hours/);
  assert.doesNotMatch(page, /live\.signups24h/);
  assert.doesNotMatch(page, /QueueStrip|getReviewQueueStats|QueueBand/);
});
