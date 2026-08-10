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
  assert.equal(preview.title, "Disguised");
  assert.match(preview.body, /\$12\.50 per open/);
  assert.equal(preview.href, "https://packy.gg/games/packs/disguised");
  assert.equal(
    preview.image,
    "https://ik.imagekit.io/scrkflpgw/packs/disguised.png",
  );
});

test("personal pack notifications preview up to three packs", () => {
  const preview = previewNotificationText("pack_release", {
    packs: [
      {
        name: "First",
        price_usd: 8,
        image_url: "https://ik.imagekit.io/scrkflpgw/packs/first.png",
      },
      {
        name: "Second",
        price_usd: 4.5,
        image_url: "https://ik.imagekit.io/scrkflpgw/packs/second.png",
      },
      { name: "Third", price_usd: 12 },
      { name: "Ignored", price_usd: 1 },
    ],
    url: "https://packy.gg/games/packs?sort=newest",
  });

  assert.equal(preview.title, "Fresh packs just dropped");
  assert.equal(preview.body, "Starting at $4.50 per open");
  assert.equal(preview.packCount, 3);
  assert.equal(preview.images?.length, 2);
  assert.equal(preview.href, "https://packy.gg/games/packs?sort=newest");
});

test("direct pack lookup keeps the personal-send capability boundary", () => {
  const actions = source("src/app/(admin)/notifications/composer-actions.ts");
  const form = source(
    "src/app/(admin)/notifications/single-notification-form.tsx",
  );
  const picker = source(
    "src/app/(admin)/notifications/notification-pack-picker.tsx",
  );

  assert.match(
    actions,
    /searchDirectNotificationPacks[\s\S]*__can_send_user_notifications/,
  );
  assert.match(
    actions,
    /searchDirectNotificationPacks[\s\S]*queryActivePacks\(query, "production"\)/,
  );
  assert.match(actions, /getProdReadDrizzleDb/);
  assert.match(
    actions,
    /orderBy\(desc\(packs\.created_at\), desc\(packs\.id\)\)/,
  );
  assert.match(
    form,
    /type=\"pack_release\"|setType\("pack_release"\)|type:\s*"pack_release"/,
  );
  assert.match(
    form,
    /pack_release:\$\{packs[\s\S]*\.map\(\(pack\) => pack\.id\)/,
  );
  assert.match(form, /MAX_NOTIFICATION_PACKS = 3/);
  assert.match(form, /\/games\/packs\?sort=newest/);
  assert.match(form, /scope=\"direct\"/);
  assert.match(form, /selectedValues=\{packs\}/);
  assert.match(form, /onSelectionChange=\{(?:applyPacks|onChange)\}/);
  assert.match(picker, /selected\.length >= maxSelected/);
  assert.match(picker, /Select up to \{maxSelected\} packs/);
  assert.match(picker, /Search packs by name or slug/);
  assert.match(picker, /Newest packs first/);
});
