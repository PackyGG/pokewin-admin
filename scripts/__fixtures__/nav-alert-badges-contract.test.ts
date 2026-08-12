import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), "utf8");
}

test("Fraud navigation badges cover fiat and account reviews", async () => {
  const [mainSidebar, antifraudSidebar, badge] = await Promise.all([
    source("src/components/app-sidebar.tsx"),
    source("src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx"),
    source("src/components/nav-alert-badge.tsx"),
  ]);

  assert.match(mainSidebar, /item\.href === "\/analytics"/);
  assert.match(mainSidebar, /searchParams\.get\("tab"\) === "fiat"/);
  assert.match(antifraudSidebar, /"\/antifraud\/fiat-deposits"/);
  assert.match(antifraudSidebar, /"\/antifraud\/reviews"/);
  assert.doesNotMatch(antifraudSidebar, /"\/antifraud\/signups"/);
  assert.match(badge, /nav-alert-seen:\$\{STORAGE_VERSION\}:\$\{viewerId\}:\$\{key\}/);
  assert.match(badge, /const STORAGE_VERSION = "v2"/);
  assert.match(badge, /document\.visibilityState === "visible"/);
  assert.match(badge, /key === activeKey/);
  assert.match(badge, /next\.checkedAt/);
  assert.match(badge, /requestSequenceRef/);
  assert.doesNotMatch(badge, /new Date\(\)\.toISOString\(\)/);
});

test("badge counts use bounded indexed event timestamps", async () => {
  const [actions, monitor, signups] = await Promise.all([
    source("src/components/nav-alert-badge-actions.ts"),
    source("services/antifraud-monitor/src/server.ts"),
    source("src/lib/antifraud/signups.ts"),
  ]);

  assert.match(actions, /MAX_LOOKBACK_MS = 30 \* 24 \* 60 \* 60 \* 1_000/);
  assert.match(actions, /WATERMARK_LAG_MS = 5_000/);
  assert.match(actions, /Math\.min\(/);
  assert.match(actions, /status IN \(/);
  assert.match(actions, /updated_at >/);
  assert.match(actions, /updated_at <=/);
  assert.match(actions, /completed_at >/);
  assert.match(actions, /completed_at <=/);
  assert.match(actions, /gt\(antifraud_reviews\.created_at/);
  assert.match(actions, /lte\(antifraud_reviews\.created_at/);
  assert.match(actions, /eq\(creator_reward_claims\.status, "pending"\)/);
  assert.match(actions, /gt\(creator_reward_claims\.requested_at/);
  assert.match(actions, /lte\(\s*creator_reward_claims\.requested_at/);
  assert.match(actions, /gt\(creator_reward_claims\.reinstated_at/);
  assert.match(actions, /lte\(\s*creator_reward_claims\.reinstated_at/);
  assert.match(monitor, /"\/v1\/signups\/unseen-count"/);
  assert.match(monitor, /first_seen_at > \$1::timestamptz/);
  assert.match(monitor, /first_seen_at <= \$2::timestamptz/);
  // The badge cap now bounds the count work itself: LIMIT 100 inside the
  // subselect instead of LEAST() over a full count.
  assert.match(monitor, /LIMIT 100\s*\)\s*bounded/);
  assert.match(signups, /until: checkedAt\.toISOString\(\)/);
});

test("Creator Rewards lives in Overview with request-first navigation and alerts", async () => {
  const [sidebar, page, content, badge] = await Promise.all([
    source("src/app/(creator-hub)/creator-hub/_components/creator-hub-sidebar.tsx"),
    source("src/app/(creator-hub)/creator-hub/rewards/page.tsx"),
    source("src/app/(creator-hub)/creator-hub/rewards/content.tsx"),
    source("src/components/nav-alert-badge.tsx"),
  ]);

  const overview = sidebar.match(/label: "Overview"[\s\S]*?\n  },/i)?.[0] ?? "";
  const programs = sidebar.match(/label: "Programs & Payouts"[\s\S]*?\n  },/i)?.[0] ?? "";
  assert.match(overview, /label: "Creator Rewards"/);
  assert.doesNotMatch(programs, /label: "Creator Rewards"/);
  assert.match(sidebar, /alertKey: "creatorRewards"/);
  assert.match(badge, /"creatorRewards"/);
  assert.match(page, /activeTab=\{tab \?\? "requests"\}/);
  assert.doesNotMatch(page, /title="Creator Rewards"/);
  assert.ok(
    content.indexOf('role="tablist"') < content.indexOf('aria-label="Search claims"'),
  );
  assert.ok(content.indexOf('value: "requests"') < content.indexOf('value: "programs"'));
});
