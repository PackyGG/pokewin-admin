import { expect, test } from "@playwright/test";

import { mintAdminSession, SESSION_COOKIE_NAME } from "./mint-session";

test("user deposits show exact Whop checkout email and unavailable state", async ({
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

  const exactEmail = page.getByText("checkout@example.com", { exact: true });
  const unavailable = page.getByTitle(
    "Whop did not provide a checkout email for this fiat deposit",
  );

  await expect(exactEmail).toHaveCount(1);
  await expect(exactEmail).toBeVisible();
  await expect(unavailable).toHaveCount(1);
  await expect(unavailable).toBeVisible();
  await expect(unavailable).toContainText("Unavailable");
});
