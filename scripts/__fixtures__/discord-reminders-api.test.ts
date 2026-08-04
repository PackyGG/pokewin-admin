import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("Discord reminders keep the exact three-user allowlist at both API boundaries", async () => {
  const [service, route] = await Promise.all([
    read("src/lib/discord-reminders.ts"),
    read("src/app/api/v1/discord/reminders/route.ts"),
  ]);

  assert.match(
    service,
    /REMINDER_USER_IDS = \[\s*"660132586630414338",\s*"934854938641715240",\s*"188051599099297802",\s*\] as const/,
  );
  assert.match(service, /isReminderUserAllowed\(input\.userId\)/);
  assert.match(route, /isReminderUserAllowed\(parsed\.data\.userId\)/);
  assert.match(service, /CREATOR_REMINDER_GUILD_ID, "1534285553661513768"/);
  assert.match(service, /VIP_REMINDER_GUILD_ID, "1534285599484149760"/);
});
