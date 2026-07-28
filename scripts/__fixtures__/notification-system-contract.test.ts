import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("the shared header mounts the notification bell", () => {
  const header = source("src/components/admin-header.tsx");
  assert.match(header, /import\s+\{\s*NotificationBell\s*\}/);
  assert.match(header, /<NotificationBell\s*\/>/);
});

test("all four dashboard webapps use the shared header", () => {
  const layouts = [
    "src/app/(admin)/layout.tsx",
    "src/app/(creator-hub)/creator-hub/layout.tsx",
    "src/app/(pack-studio)/pack-studio/layout.tsx",
    "src/app/(antifraud)/antifraud/layout.tsx",
  ];

  for (const layout of layouts) {
    assert.match(source(layout), /<AdminHeader\b/, `${layout} lost AdminHeader`);
  }
});

test("daily reward grants cannot enter the shared staff inbox", () => {
  const notifications = source("src/lib/staff/notifications.ts");

  assert.match(
    notifications,
    /DISABLED_AUTOMATED_STAFF_SIGNAL_KINDS[\s\S]*"daily_reward_granted"/,
  );
  assert.match(
    notifications,
    /if \(isDisabledAutomatedStaffNotification\(input\)\) return 0;/,
  );
  assert.match(
    notifications,
    /IS DISTINCT FROM 'daily_reward_granted'/,
  );
});

test("System navigation and the bell point to the notification handler", () => {
  const nav = source("src/lib/nav-config.ts");
  const bell = source("src/components/notification-bell.tsx");
  const page = source(
    "src/app/(admin)/system/staff-notifications/page.tsx",
  );

  assert.match(nav, /href:\s*"\/system\/staff-notifications"/);
  assert.match(bell, /href="\/system\/staff-notifications"/);
  assert.match(page, /StaffNotificationComposer/);
  assert.match(page, /listStaffNotifications/);
});

test("the restore migration owns notification tables independently", () => {
  const migration = source(
    "drizzle/admin/migrations/20260726_restore_staff_notifications.sql",
  );

  for (const table of [
    "staff_notifications",
    "staff_notification_channels",
    "staff_notification_prefs",
  ]) {
    assert.match(
      migration,
      new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`),
    );
  }

  assert.doesNotMatch(migration, /staff_profiles|staff_quiz/);
});
