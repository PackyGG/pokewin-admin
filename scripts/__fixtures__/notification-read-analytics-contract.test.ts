import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { STATUS_COLORS } from "@/lib/constants";
import { announcementStatus } from "@/app/(admin)/notifications/announcement-status";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("announcement history reports exact site-marked read totals", () => {
  const api = source("src/lib/backend-api/announcements.ts");
  const content = source(
    "src/app/(admin)/notifications/announcements-content.tsx",
  );

  assert.match(api, /from\(announcement_reads\)/);
  assert.match(
    api,
    /\.groupBy\(announcement_reads\.announcement_id\)/,
  );
  assert.match(content, />Marked read</);
  assert.match(content, /not a guaranteed impression/);
});

test("revoked announcements render red and remain distinct from ended and active", () => {
  const now = Date.parse("2026-07-29T12:00:00.000Z");
  const revoked = announcementStatus(
    {
      revoked_at: "2026-07-29T11:00:00.000Z",
      starts_at: "2026-07-29T10:00:00.000Z",
      ends_at: null,
    },
    now,
  );
  const ended = announcementStatus(
    {
      revoked_at: null,
      starts_at: "2026-07-29T10:00:00.000Z",
      ends_at: "2026-07-29T11:00:00.000Z",
    },
    now,
  );
  const active = announcementStatus(
    {
      revoked_at: null,
      starts_at: "2026-07-29T10:00:00.000Z",
      ends_at: null,
    },
    now,
  );

  assert.deepEqual(revoked, {
    label: "Revoked",
    className: STATUS_COLORS.failed,
  });
  assert.equal(ended.label, "Ended");
  assert.equal(active.label, "Active");
  assert.notEqual(revoked.className, ended.className);
  assert.notEqual(revoked.className, active.className);
});

test("new direct sends retain exact indexed notification identities", () => {
  const direct = source("src/app/(admin)/notifications/direct-actions.ts");
  const reward = source("src/app/(admin)/notifications/reward-actions.ts");

  for (const action of [direct, reward]) {
    assert.match(action, /trackingItems:/);
    assert.match(action, /userId:/);
    assert.match(action, /dedupeKey:/);
  }
});

test("direct read analytics stay bounded and use the unique notification pair", () => {
  const analytics = source(
    "src/app/(admin)/notifications/_queries/direct-read-analytics.ts",
  );
  const history = source(
    "src/app/(admin)/notifications/direct-notification-history.tsx",
  );

  assert.match(analytics, /MAX_TRACKED_REFS_PER_RENDER = 25_000/);
  assert.match(
    analytics,
    /notifications\.user_id = tracked\.user_id/,
  );
  assert.match(
    analytics,
    /notifications\.dedupe_key = tracked\.dedupe_key/,
  );
  assert.match(history, /Older bulk sends may show unavailable/);
  assert.match(history, /impression, time viewed, or link click/);
});
