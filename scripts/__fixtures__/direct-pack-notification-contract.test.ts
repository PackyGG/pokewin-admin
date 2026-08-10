import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { previewNotificationText } from "@/lib/user-notification-templates";

const root = process.cwd();
const source = (path: string) => readFileSync(`${root}/${path}`, "utf8");

test("personal pack notifications have a truthful visible preview", () => {
  const preview = previewNotificationText("pack_release", {
    pack_name: "Disguised",
    price_usd: 12.5,
    url: "https://packy.gg/games/packs/disguised",
    image_url: "https://ik.imagekit.io/scrkflpgw/packs/disguised.png",
  });

  assert.equal(preview.known, true);
  assert.equal(preview.title, "New pack: Disguised");
  assert.match(preview.body, /\$12\.50 per open/);
  assert.equal(preview.href, "https://packy.gg/games/packs/disguised");
  assert.equal(
    preview.image,
    "https://ik.imagekit.io/scrkflpgw/packs/disguised.png",
  );
});

test("direct pack lookup keeps the personal-send capability boundary", () => {
  const actions = source("src/app/(admin)/notifications/composer-actions.ts");
  const form = source(
    "src/app/(admin)/notifications/single-notification-form.tsx",
  );

  assert.match(
    actions,
    /searchDirectNotificationPacks[\s\S]*__can_send_user_notifications/,
  );
  assert.match(form, /type=\"pack_release\"|setType\("pack_release"\)/);
  assert.match(form, /pack_release:\$\{pack\.id\}:\$\{userId\.trim\(\)\}/);
  assert.match(form, /scope=\"direct\"/);
});
