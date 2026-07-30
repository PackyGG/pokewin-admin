import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function sourceFiles(path: string): string[] {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap(
    (entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) return sourceFiles(child);
      return /\.(?:ts|tsx)$/.test(entry.name) ? [child] : [];
    },
  );
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

test("only owner/admin announcements can enter the shared staff inbox", () => {
  const notifications = source("src/lib/staff/notifications.ts");
  const action = source(
    "src/app/(admin)/system/staff-notifications/actions.ts",
  );
  assert.match(
    notifications,
    /MANUAL_ANNOUNCEMENT_KIND:\s*StaffNotificationKind\s*=\s*"announcement"/,
  );
  assert.match(
    notifications,
    /export async function sendStaffAnnouncement/,
  );
  assert.match(
    notifications,
    /session\.userId !== input\.actorAdminUserId[\s\S]*sessionIsAdmin\(session\)[\s\S]*sessionIsOwner\(session\)/,
  );
  assert.match(
    action,
    /sessionIsAdmin\(session\)[\s\S]*sessionIsOwner\(session\)/,
  );
  assert.match(action, /sendStaffAnnouncement\(\{/);

  const applicationSources = sourceFiles("src").filter(
    (path) =>
      !path.startsWith(join("src", "generated")) &&
      !path.startsWith(join("src", "lib", "db-schema")),
  );
  const staffNotificationConsumers = applicationSources.filter((path) =>
    /(?:from|insert|update|delete)\(staff_notifications\)|staff_notifications\.\w+/.test(
      source(path),
    ),
  );
  assert.deepEqual(
    staffNotificationConsumers,
    [join("src", "lib", "staff", "notifications.ts")],
    "staff_notifications must only be accessed by its generated schema and shared manual boundary",
  );

  const announcementCallers = applicationSources.filter(
    (path) =>
      path !== join("src", "lib", "staff", "notifications.ts") &&
      /\bsendStaffAnnouncement\s*\(/.test(source(path)),
  );
  assert.deepEqual(
    announcementCallers,
    [join("src", "app", "(admin)", "system", "staff-notifications", "actions.ts")],
    "the dedicated manual composer must remain the only announcement caller",
  );

  for (const path of applicationSources) {
    assert.doesNotMatch(
      source(path),
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["'`]?staff_notifications\b/i,
      `${path} bypasses the shared staff notification boundary with raw SQL`,
    );
    assert.doesNotMatch(
      source(path),
      /\bnotifyStaff\s*\(/,
      `${path} restored a legacy automatic staff notification writer`,
    );
  }
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

test("staff announcements are not a Fraud Discord Routing action", () => {
  const channels = source("src/lib/staff/channels.ts");
  const removal = source(
    "drizzle/admin/migrations/20260730_zz_remove_staff_announcement_discord_event.sql",
  );

  assert.match(channels, /ANTIFRAUD_DISCORD_WEBHOOK_URL/);
  assert.doesNotMatch(channels, /enqueueDiscordEvent|staff\.announcement/);
  assert.match(
    removal,
    /DELETE FROM discord_notification_events[\s\S]*staff\.announcement/,
  );
});
