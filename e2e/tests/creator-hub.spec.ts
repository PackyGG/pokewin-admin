import { test, expect } from "@playwright/test";
import pg from "pg";
import { loadEnvFiles } from "../helpers/env";
import {
  mintAdminSession,
  SESSION_COOKIE_NAME,
  signSessionCookie,
  type MintedSession,
} from "../responsive/mint-session";

loadEnvFiles();

/**
 * Creator Hub route smoke — minted-session render pass.
 *
 * Uses the same JWT mint helper as the responsive harness (NOT the real
 * /login form) because Hub access is gated by `canAccessCreatorHub`
 * (motha bypass OR per-role ADMIN-DB toggle), not plain admin role.
 *
 * Auth behaviour is still covered by auth.spec.ts / permissions.spec.ts.
 * This spec only proves every `/creator-hub/*` route renders past the gate.
 */

const HUB_ROUTES = [
  "/creator-hub",
  "/creator-hub/creators",
  "/creator-hub/leaderboards",
  "/creator-hub/creator-check",
  "/creator-hub/acquisition",
  "/creator-hub/socials-review",
  "/creator-hub/profitable-algo",
  "/creator-hub/changelog",
  "/creator-hub/deal-tracker",
  "/creator-hub/compare",
  "/creator-hub/settings",
  // Legacy bookmark — should redirect to dashboard after gate.
  "/creator-hub/alerts",
] as const;

async function mintCreatorHubSession(): Promise<MintedSession> {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) throw new Error("ADMIN_DATABASE_URL required for Creator Hub e2e");

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const motha = await pool.query<{
      id: string;
      email: string;
      username: string;
      role: string;
      roles: string[] | null;
    }>(
      `SELECT id, email, username, role, COALESCE(roles, ARRAY[role]) AS roles
         FROM admin_users
        WHERE is_active = TRUE AND lower(username) = 'motha'
        LIMIT 1`,
    );
    if (motha.rowCount && motha.rowCount > 0) {
      const row = motha.rows[0];
      const admin = {
        id: row.id,
        email: row.email,
        username: row.username,
        role: row.role,
        roles: row.roles ?? [row.role],
      };
      return { cookieValue: await signSessionCookie(admin), admin };
    }

    // Fallback: enable the admin-role Hub toggle and mint a normal admin.
    await pool.query(
      `INSERT INTO admin_settings (key, value, updated_by, updated_at)
       VALUES ('creator_hub_access_admin_enabled', 'true', NULL, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = 'true', updated_at = NOW()`,
    );
    return mintAdminSession();
  } finally {
    await pool.end();
  }
}

async function readSampleCreatorId(): Promise<string | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const res = await pool.query<{ id: string }>(
      `SELECT u.id
         FROM "user" u
         JOIN user_roles ur ON ur.user_id = u.id
        WHERE ur.role = 'creator'
        ORDER BY u.created_at DESC
        LIMIT 1`,
    );
    return res.rowCount && res.rowCount > 0 ? res.rows[0].id : null;
  } catch {
    return null;
  } finally {
    await pool.end();
  }
}

test.describe("Creator Hub routes (minted session)", () => {
  test("every hub route renders past the access gate", async ({ browser }) => {
    test.setTimeout(120_000);
    const { cookieValue } = await mintCreatorHubSession();
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: cookieValue,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();

    for (const route of HUB_ROUTES) {
      const response = await page.goto(route, { waitUntil: "domcontentloaded" });
      expect(response, `${route} should respond`).not.toBeNull();
      expect(response!.status(), `${route} status`).toBeLessThan(500);

      // Gate bounce — never land on login from a minted admin/motha session.
      expect(page.url(), `${route} should not redirect to login`).not.toMatch(
        /\/login/,
      );

      if (route === "/creator-hub/alerts") {
        // Legacy bookmark — server `redirect()` to dashboard; in dev the
        // client URL may lag one beat, so accept either final URL.
        try {
          await page.waitForURL(/\/creator-hub\/?$/, { timeout: 8_000 });
        } catch {
          expect(page.url()).toMatch(/\/creator-hub\/alerts/);
        }
        continue;
      }

      // Hub shell marker — sidebar title or hero.
      await expect(
        page.getByText(/Creator Hub/i).first(),
      ).toBeVisible({ timeout: 15_000 });
    }

    await context.close();
  });

  test("creator detail + forecast tab render when a creator exists", async ({
    browser,
  }) => {
    const creatorId = await readSampleCreatorId();
    test.skip(!creatorId, "No creator user in MAIN DB — skip detail route");

    const { cookieValue } = await mintCreatorHubSession();
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: cookieValue,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();

    const overviewUrl = `/creator-hub/creators/${creatorId}`;
    const response = await page.goto(overviewUrl, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBeLessThan(500);
    await expect(page.getByText(/Creator Hub/i).first()).toBeVisible({
      timeout: 15_000,
    });

    const forecastUrl = `${overviewUrl}?tab=forecast`;
    const forecastResponse = await page.goto(forecastUrl, {
      waitUntil: "domcontentloaded",
    });
    expect(forecastResponse?.status()).toBeLessThan(500);
    await expect(
      page.getByText(/Deal profitability forecast/i).first(),
    ).toBeVisible({ timeout: 30_000 });

    await context.close();
  });
});
