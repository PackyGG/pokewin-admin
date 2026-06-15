/* eslint-disable */
// Render-verify for the UNIFIED ROLE SYSTEM (RoleV2 P0-P4 + one Roles concept).
// Mints a `motha` (root owner / superuser) session and drives the real routes
// + dialogs at desktop 1280 and mobile 390 against a PROD build (next start).
//
// NOT committed-critical — a verification harness. Run via:
//   E2E_USE_EXISTING_SERVER=1 E2E_BASE_URL=http://localhost:<port> \
//   npx playwright test --config=playwright.responsive.config.ts unified-roles-verify
//
// Asserts (per the task's render-verify checklist):
//   • ONE Roles list (no "Built-in"/"Custom" badges; System/Superuser pills;
//     kebab ⋯; single "Open" CTA)
//   • open Support (system) editor → name input ENABLED (now renameable)
//   • open admin editor → read-only superuser (bypass view, no toggles)
//   • Duplicate dialog opens pre-filled ("<name> copy")
//   • landing-route input renders in the editor
//   • Delete disabled on a system row (kebab)
//   • the "Role preset" select renders on /admin-users/[id]
//   • no horizontal overflow at 390
//   • 0 console errors per route

import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";
import { signSessionCookie } from "./mint-session";
import pg from "pg";

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };

// Resolved at runtime (read-only) so the spec isn't pinned to hardcoded ids.
let mothaCookie = "";
let supportRoleId = "";
let adminRoleId = "";
let customRoleId = "";
let nonAdminUserId = "";

test.beforeAll(async () => {
  const pool = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 1 });
  try {
    const motha = await pool.query<{
      id: string; email: string; username: string; role: string; roles: string[] | null;
    }>(
      `SELECT id, email, username, role, COALESCE(roles, ARRAY[role]) AS roles
         FROM admin_users WHERE username='motha' LIMIT 1`,
    );
    if (!motha.rowCount) throw new Error("motha not found in ADMIN DB");
    const m = motha.rows[0];
    mothaCookie = await signSessionCookie({
      id: m.id, email: m.email, username: m.username, role: m.role, roles: m.roles ?? [m.role],
    });

    const support = await pool.query<{ id: string }>(
      `SELECT id FROM admin_roles WHERE system_key='support' LIMIT 1`,
    );
    supportRoleId = support.rows[0]?.id ?? "";
    const adminR = await pool.query<{ id: string }>(
      `SELECT id FROM admin_roles WHERE system_key='admin' LIMIT 1`,
    );
    adminRoleId = adminR.rows[0]?.id ?? "";
    const custom = await pool.query<{ id: string }>(
      `SELECT id FROM admin_roles WHERE is_system=false ORDER BY name LIMIT 1`,
    );
    customRoleId = custom.rows[0]?.id ?? "";
    const nonAdmin = await pool.query<{ id: string }>(
      `SELECT id FROM admin_users
        WHERE role <> 'admin' AND (roles IS NULL OR NOT ('admin' = ANY(roles)))
        ORDER BY username LIMIT 1`,
    );
    nonAdminUserId = nonAdmin.rows[0]?.id ?? "";
  } finally {
    await pool.end();
  }
});

async function ctxWithCookie(page: Page) {
  const url = new URL(page.url() === "about:blank" ? (process.env.E2E_BASE_URL ?? "http://localhost:3000") : page.url());
  await page.context().addCookies([
    {
      name: "admin_session",
      value: mothaCookie,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

// Pre-existing whole-app console noise UNRELATED to the role surface (documented
// in AGENT_HANDOFF): the topbar house-stats safeQuery timeout, Recharts
// `data-chart` id + cmdk dialog-description hydration mismatches, and transient
// resource fetches. Filtered so the assertion only catches errors MY surface
// introduces.
const KNOWN_NOISE = [
  /costBreakdown/i,
  /houseStats/i,
  /safeQuery/i,
  /data-chart/i,
  /aria-describedby/i,
  /Description.*DialogContent/i,
  /hydrat/i,
  /Failed to load resource/i,
  /favicon/i,
  /the server responded with a status of/i,
];

function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (KNOWN_NOISE.some((re) => re.test(t))) return;
    errors.push(t);
  });
  page.on("pageerror", (e) => {
    if (KNOWN_NOISE.some((re) => re.test(e.message))) return;
    errors.push(`pageerror: ${e.message}`);
  });
  return errors;
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth > d.clientWidth + 1;
  });
}

test("desktop 1280 — one Roles list, pills, kebab, single Open", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await ctxWithCookie(page);
  const errors = trackConsole(page);

  await page.goto("/admin-users?tab=roles", { waitUntil: "domcontentloaded" });

  // The "Roles" section heading + KPI "Roles" tile exist.
  await expect(page.getByRole("heading", { name: "Roles", exact: true })).toBeVisible();

  // NO "Built-in" / "Custom" badges anywhere on the unified grid.
  await expect(page.getByText("Built-in", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Custom", { exact: true })).toHaveCount(0);

  // System pill (on the 6 enum roles) + Superuser pill (on admin) present.
  await expect(page.getByText("System", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Superuser", { exact: true })).toBeVisible();

  // Single "Open" CTA appears (at least one card has it).
  await expect(page.getByRole("link", { name: "Open", exact: true }).first()).toBeVisible();

  // Kebab actions buttons present (one per card).
  const kebabs = page.getByRole("button", { name: /^Actions for / });
  expect(await kebabs.count()).toBeGreaterThan(5); // 6 system + ≥1 custom

  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});

test("desktop 1280 — Support (system) editor: name input enabled + landing route input", async ({ page }) => {
  test.skip(!supportRoleId, "no support role id");
  await page.setViewportSize(DESKTOP);
  await ctxWithCookie(page);
  const errors = trackConsole(page);

  await page.goto(`/admin-users/roles/${supportRoleId}`, { waitUntil: "domcontentloaded" });

  // Name input is now ENABLED for a system row (P3 rename relaxation).
  const nameInput = page.locator("#role-name").first();
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toBeEnabled();

  // Landing-page select renders (P4). base-ui Select renders a visible trigger
  // + a hidden mirror sharing the id → target the visible combobox.
  await expect(page.getByRole("combobox", { name: /Landing page/ })).toBeVisible();
  await expect(page.getByText("Landing page", { exact: true }).first()).toBeVisible();

  // "Assigned admins" panel renders.
  await expect(page.getByRole("heading", { name: "Assigned admins" })).toBeVisible();

  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});

test("desktop 1280 — admin editor is read-only superuser (bypass view)", async ({ page }) => {
  test.skip(!adminRoleId, "no admin role id");
  await page.setViewportSize(DESKTOP);
  await ctxWithCookie(page);
  const errors = trackConsole(page);

  await page.goto(`/admin-users/roles/${adminRoleId}`, { waitUntil: "domcontentloaded" });

  // Bypass copy is shown; NO editable name input (read-only AdminBypassView).
  await expect(
    page.getByText(/bypasses every page and capability check/i).first(),
  ).toBeVisible();
  await expect(page.locator("#role-name")).toHaveCount(0);
  // No landing select for the superuser.
  await expect(page.locator("#role-landing")).toHaveCount(0);

  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});

test("desktop 1280 — Duplicate dialog opens pre-filled; Delete disabled on system row", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await ctxWithCookie(page);
  const errors = trackConsole(page);

  await page.goto("/admin-users?tab=roles", { waitUntil: "domcontentloaded" });

  // Open the Support card's kebab → Duplicate.
  const supportKebab = page.getByRole("button", { name: /^Actions for Support/ }).first();
  await supportKebab.click();
  // Duplicate menu item.
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  // Dialog pre-filled with "<name> copy".
  const dupName = page.locator("#dup-name");
  await expect(dupName).toBeVisible();
  await expect(dupName).toHaveValue(/ copy$/);
  // CANCEL — do NOT mutate.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(dupName).toHaveCount(0);

  // Re-open the kebab and assert the Delete item is disabled on a system row.
  await supportKebab.click();
  const del = page.getByRole("menuitem", { name: "Delete" });
  await expect(del).toBeVisible();
  await expect(del).toBeDisabled();
  await page.keyboard.press("Escape");

  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});

test("desktop 1280 — Role preset select renders on /admin-users/[id]", async ({ page }) => {
  test.skip(!nonAdminUserId, "no non-admin user id");
  await page.setViewportSize(DESKTOP);
  await ctxWithCookie(page);
  const errors = trackConsole(page);

  await page.goto(`/admin-users/${nonAdminUserId}`, { waitUntil: "domcontentloaded" });

  // The Roles card + the "Role preset" label/select render.
  await expect(page.getByText("Role preset", { exact: true }).first()).toBeVisible();
  const presetSelect = page.getByRole("combobox", { name: "Role preset" }).first();
  await expect(presetSelect).toBeVisible();
  // Open it then CANCEL (Escape) — do NOT assign.
  await presetSelect.click();
  await expect(page.getByRole("option", { name: "No preset" }).first()).toBeVisible();
  await page.keyboard.press("Escape");

  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});

test("mobile 390 — roles list has no horizontal overflow + 0 console errors", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await ctxWithCookie(page);
  const errors = trackConsole(page);

  await page.goto("/admin-users?tab=roles", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Roles", exact: true })).toBeVisible();
  expect(await hasHorizontalOverflow(page), "horizontal overflow at 390").toBe(false);

  // Editor at 390 too.
  if (supportRoleId) {
    await page.goto(`/admin-users/roles/${supportRoleId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("combobox", { name: /Landing page/ })).toBeVisible();
    expect(await hasHorizontalOverflow(page), "editor overflow at 390").toBe(false);
  }

  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});
