import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), "utf8");
}

test("navigation badges cover fiat, signups, and account reviews", async () => {
  const [mainSidebar, antifraudSidebar, badge] = await Promise.all([
    source("src/components/app-sidebar.tsx"),
    source("src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx"),
    source("src/components/nav-alert-badge.tsx"),
  ]);

  assert.match(mainSidebar, /item\.href === "\/fiat"/);
  assert.match(antifraudSidebar, /"\/antifraud\/fiat-deposits"/);
  assert.match(antifraudSidebar, /"\/antifraud\/signups"/);
  assert.match(antifraudSidebar, /"\/antifraud\/reviews"/);
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
  assert.match(monitor, /"\/v1\/signups\/unseen-count"/);
  assert.match(monitor, /source_created_at > \$1::timestamptz/);
  assert.match(monitor, /source_created_at <= \$2::timestamptz/);
  assert.match(monitor, /LEAST\(COUNT\(\*\), 100\)/);
  assert.match(signups, /until: checkedAt\.toISOString\(\)/);
});
