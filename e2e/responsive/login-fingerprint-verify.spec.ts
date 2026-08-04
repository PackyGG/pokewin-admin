import { expect, test } from "@playwright/test";

import { mintAdminSession, SESSION_COOKIE_NAME } from "./mint-session";

test("user detail exposes verified login fingerprint evidence", async ({
  page,
  context,
}) => {
  const session = await mintAdminSession();
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: session.cookieValue,
      url: "http://127.0.0.1:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  await page.goto(
    "http://127.0.0.1:3000/responsive-fixture/users-detail",
    { waitUntil: "domcontentloaded" },
  );

  const device = page.locator(
    '[title*="Signup captures: 1. Login captures: 2."]',
  );
  await expect(device).toHaveCount(1);
  await expect(device).toBeVisible();
  await expect(device).toHaveAttribute(
    "title",
    /Latest verified login: 2026-08-04 19:30 UTC from 203\.0\.113\.42 on Ibk1527CUFmcnjLwIs4A/,
  );
});
