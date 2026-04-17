import { test, expect, performLogin } from "../fixtures/base";

/**
 * Auth flow.
 *
 * These tests exercise the real /login + /verify-2fa pages. No bypass
 * endpoints, no cookie injection — if the seeded admin can't log in, the
 * suite is meant to fail loudly because the admin panel is broken.
 */

test.describe("auth", () => {
  // Don't use the adminPage fixture here — each test manages its own
  // context so we can control the pre-login state.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("valid credentials → dashboard", async ({ page, adminCredentials }) => {
    await performLogin(page, adminCredentials);

    // The root admin role routes to /dashboard (see
    // src/middleware.ts defaultRoutes["admin"]).
    await expect(page).toHaveURL(/\/dashboard($|\?)/);
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
  });

  test("wrong password → inline error, still on /login", async ({
    page,
    adminCredentials,
  }) => {
    await page.goto("/login");
    await page.getByLabel(/^email$/i).fill(adminCredentials.email);
    await page.getByLabel(/^password$/i).fill("not-the-real-password");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Error text is rendered inline by the server action result; make
    // sure it actually shows and we haven't bounced off /login.
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("log out → redirected to /login", async ({ browser, adminCredentials }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await performLogin(page, adminCredentials);
    await expect(page).toHaveURL(/\/dashboard/);

    // Logout lives in the header as an icon-only button. Both aria-label
    // and title say "Log out" — we click via aria-label for stability.
    await page.getByRole("button", { name: /log out/i }).click();

    await page.waitForURL(/\/login$/, { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();

    // After logout, hitting a protected route must bounce back to /login.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login($|\?)/);

    await context.close();
  });

  test("unauthenticated visit to /users bounces to /login", async ({ page }) => {
    await page.goto("/users");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  });
});
