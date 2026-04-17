import { test as base, expect, type Page } from "@playwright/test";
import { currentTotp, getE2EAdminTotpSecret } from "../helpers/totp";
import {
  closePools,
  createScratchUser,
  deleteScratchUser,
  type ScratchUser,
} from "../helpers/db";

/**
 * Base test fixtures for the pokewin-admin E2E suite.
 *
 * Two fixtures are exposed:
 *
 *   - `adminPage`        — a Page that is already logged into the admin
 *                          panel as the dedicated E2E admin (dedicated
 *                          account seeded by scripts/seed-e2e-admin.ts).
 *                          Auth happens through the real /login + 2FA
 *                          forms — we do not bypass the session system.
 *
 *   - `makeScratchUser`  — factory that creates a throwaway main-DB user
 *                          and schedules its deletion after the test.
 *                          Tests that need to poke the user-detail page
 *                          use this so they don't run against a real user.
 *
 * Teardown is automatic. If a test bails mid-way, the afterEach still
 * runs and reclaims whatever rows were created.
 */

// ---------------------------------------------------------------------------
// Login helper — extracted so the fixture and the auth.spec tests can share
// one source of truth for the real-form login flow.
// ---------------------------------------------------------------------------

export async function performLogin(
  page: Page,
  opts: { email: string; password: string; totpSecret?: string },
) {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.getByLabel(/^email$/i).fill(opts.email);
  await page.getByLabel(/^password$/i).fill(opts.password);
  await page.getByRole("button", { name: /sign in/i }).click();

  // After submit the server decides whether we go to /verify-2fa or
  // straight to the default route. Wait until we land somewhere stable.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });

  if (page.url().includes("/verify-2fa")) {
    if (!opts.totpSecret) {
      throw new Error(
        "performLogin: server required 2FA but no totpSecret was provided",
      );
    }
    await page
      .getByLabel(/authentication code/i)
      .fill(currentTotp(opts.totpSecret));
    await page.getByRole("button", { name: /^verify$/i }).click();
    await page.waitForURL(
      (url) =>
        !url.pathname.startsWith("/verify-2fa") &&
        !url.pathname.startsWith("/login"),
      { timeout: 15_000 },
    );
  }
}

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

type MakeScratchUser = (
  overrides?: Partial<Pick<ScratchUser, "email" | "username">>,
) => Promise<ScratchUser>;

type Fixtures = {
  adminPage: Page;
  makeScratchUser: MakeScratchUser;
  adminTotpSecret: string;
  adminCredentials: {
    email: string;
    username: string;
    password: string;
    totpSecret: string;
  };
};

// ---------------------------------------------------------------------------
// Extended test runner
// ---------------------------------------------------------------------------

export const test = base.extend<Fixtures>({
  adminCredentials: async ({}, use) => {
    const email = process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@test.local";
    const username = process.env.E2E_ADMIN_USERNAME ?? "e2e_admin";
    const password = process.env.E2E_ADMIN_PASSWORD ?? "E2EAdmin!Pass123";
    const totpSecret = getE2EAdminTotpSecret();
    await use({ email, username, password, totpSecret });
  },

  adminTotpSecret: async ({ adminCredentials }, use) => {
    await use(adminCredentials.totpSecret);
  },

  adminPage: async ({ browser, adminCredentials }, use) => {
    // Each test gets a fresh isolated context so cookies / storage
    // don't leak between specs. The whole point of an admin fixture
    // is deterministic state — shared context defeats that.
    const context = await browser.newContext();
    const page = await context.newPage();
    await performLogin(page, adminCredentials);
    await use(page);
    await context.close();
  },

  makeScratchUser: async ({}, use) => {
    const created: string[] = [];
    const make: MakeScratchUser = async (overrides) => {
      const user = await createScratchUser(overrides);
      created.push(user.id);
      return user;
    };
    await use(make);
    // Teardown — delete every user this test created, in reverse
    // order so FK cascades don't trip each other up.
    for (const id of created.reverse()) {
      try {
        await deleteScratchUser(id);
      } catch (err) {
        // Don't fail the test on teardown errors — the sweep in
        // global-setup will mop up any stragglers on the next run.
        console.warn(`[e2e] failed to delete scratch user ${id}:`, err);
      }
    }
  },
});

// Run once after the entire test process — close the DB pools so the
// Node worker can exit cleanly on CI.
test.afterAll(async () => {
  await closePools();
});

export { expect };
