import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { previewNotificationText } from "@/lib/user-notification-templates";
import { validateAnnouncementPayload } from "@/lib/announcement-payload";

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

test("single-pack previews match the site fallback copy and pack link", () => {
  const preview = previewNotificationText("pack_release", {
    packs: [
      {
        name: "Only Pack",
        url: "https://packy.gg/games/packs/only-pack",
      },
    ],
  });

  assert.equal(preview.title, "Only Pack");
  assert.equal(preview.body, "Available now");
  assert.equal(preview.href, "https://packy.gg/games/packs/only-pack");
});

test("broadcast pack announcements preserve the shared one-to-three-pack contract", () => {
  const result = validateAnnouncementPayload({
    url: "https://packy.gg/games/packs?sort=newest",
    ctaLabel: "View new packs",
    packs: [
      {
        name: "Newest",
        priceUsd: 8,
        url: "https://packy.gg/games/packs/newest",
        imageUrl: "https://ik.imagekit.io/scrkflpgw/packs/newest.png",
      },
      {
        name: "Second",
        priceUsd: 5,
        url: "https://packy.gg/games/packs/second",
        imageUrl: null,
      },
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload?.packs?.length, 2);
  assert.equal(result.payload?.packs?.[0].name, "Newest");
  assert.equal(result.payload?.packs?.[0].price_usd, "8.00");

  assert.equal(
    validateAnnouncementPayload({
      packs: Array.from({ length: 4 }, (_, index) => ({
        name: `Pack ${index}`,
        priceUsd: index,
        url: `https://packy.gg/games/packs/pack-${index}`,
        imageUrl: null,
      })),
    }).ok,
    false,
  );
});

test("broadcast promo announcements retain reveal-card metadata", () => {
  const result = validateAnnouncementPayload({
    promoCode: " summer-25 ",
    promoValueUsd: "25",
  });
  assert.deepEqual(result, {
    ok: true,
    payload: { code: "SUMMER-25", value: "25.00" },
  });
  assert.equal(validateAnnouncementPayload({ promoValueUsd: "25" }).ok, false);
});

test("direct pack lookup keeps the personal-send capability boundary", () => {
  const actions = source("src/app/(admin)/notifications/composer-actions.ts");
  const form = source(
    "src/app/(admin)/notifications/single-notification-form.tsx",
  );
  const picker = source(
    "src/app/(admin)/notifications/notification-pack-picker.tsx",
  );
  const packComposer = source(
    "src/app/(admin)/notifications/pack-notification-composer.tsx",
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
    actions,
    /createdAt: new Date\(p\.created_at\)\.toISOString\(\)/,
  );
  assert.match(
    form,
    /type=\"pack_release\"|setType\("pack_release"\)|type:\s*"pack_release"/,
  );
  assert.match(
    form,
    /pack_release:\$\{packs[\s\S]*\.map\(\(pack\) => pack\.id\)/,
  );
  assert.match(form, /\/games\/packs\?sort=newest/);
  assert.match(form, /scope=\"direct\"/);
  assert.match(form, /<PackNotificationComposer/);
  assert.match(packComposer, /MAX_NOTIFICATION_PACKS = 3/);
  assert.match(packComposer, /selectedValues=\{packs\}/);
  assert.match(packComposer, /onSelectionChange=\{onChange\}/);
  assert.match(picker, /selected\.length >= maxSelected/);
  assert.match(picker, /Select up to \{maxSelected\} packs/);
  assert.match(picker, /Search packs by name or slug/);
  assert.match(picker, /Newest packs first/);
  assert.match(picker, /newestPacksFirst/);

  const announcement = source(
    "src/app/(admin)/notifications/create-announcement-dialog.tsx",
  );
  assert.match(announcement, /<PackNotificationComposer/);
  assert.match(announcement, /scope=\"announcement\"/);
  assert.match(announcement, /<NotificationPreview/);
  assert.match(announcement, /type=\{TEMPLATE_TYPES\.pack\}/);
  assert.match(announcement, /composedPayloadCheck\.payload/);
  assert.match(announcement, /composedPayloadCheck\.error/);
  assert.match(announcement, /showHeading=\{false\}/);
  assert.match(announcement, /!packAutoFilled/);
  assert.match(announcement, /next === "pack"[\s\S]*TEMPLATE_TYPES\.pack/);
  assert.match(announcement, /template !== "pack"/);
  assert.doesNotMatch(announcement, /<Label[^>]*>Pack<\/Label>/);
  assert.match(
    announcement,
    /\{packAutoFilled \? \([\s\S]{0,200}<NotificationPreview[\s\S]*?\) : \(\s*<AnnouncementPreview/,
  );
  assert.match(announcement, /promo: "promo_code_granted"/);
  assert.match(
    actions,
    /searchAnnouncementPacks[\s\S]*queryActivePacks\(query, "production"\)/,
  );
});
