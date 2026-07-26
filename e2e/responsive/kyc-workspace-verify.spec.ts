import { expect, test } from "@playwright/test";

import {
  mintAdminSession,
  SESSION_COOKIE_NAME,
} from "./mint-session";

test.use({ channel: "chrome" });

test("Antifraud KYC workspace renders live data without layout or console failures", async ({
  context,
  page,
  baseURL,
}) => {
  const { cookieValue } = await mintAdminSession();
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: cookieValue,
      url: baseURL ?? "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/antifraud/kyc", { waitUntil: "networkidle" });

  await expect(page).toHaveURL(/\/antifraud\/kyc$/);
  await expect(page.getByRole("heading", { name: "KYC" })).toBeVisible();
  await expect(page.getByRole("link", { name: "KYC" })).toBeVisible();
  await expect(page.getByText("Configuration and policy")).toBeVisible();
  await expect(page.getByText("Accounts", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Require KYC" }),
  ).toBeVisible();

  const firstAccount = page.locator("details").first();
  if ((await firstAccount.count()) > 0) {
    await firstAccount.locator("summary").click();
    await expect(
      firstAccount.getByText("Sumsub provider evidence"),
    ).toBeVisible();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    )
    .toBe(true);

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
