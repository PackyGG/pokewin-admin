import crypto from "node:crypto";
import { test, expect } from "../fixtures/base";
import { cleanupE2EAdminRoles, scratchPrefix } from "../helpers/db";

/**
 * /settings/roles — custom roles system.
 *
 * Lightweight coverage:
 *   - the four built-in system roles are present and badged "System"
 *   - creating a new custom role persists and appears in the list
 *
 * After-all sweep wipes any leftover `_e2e_*` custom roles.
 */

const SYSTEM_ROLES = ["admin", "support", "marketing", "creator"];

test.describe("permissions — admin roles", () => {
  test.afterAll(async () => {
    await cleanupE2EAdminRoles();
  });

  test("system roles listed as read-only", async ({ adminPage }) => {
    await adminPage.goto("/settings/roles");
    await expect(
      adminPage.getByRole("heading", { name: /admin roles/i }),
    ).toBeVisible();

    // Every seeded system role shows up as a link row, and its type
    // column is badged "System".
    for (const name of SYSTEM_ROLES) {
      const row = adminPage.locator("tr", {
        has: adminPage.getByRole("link", { name, exact: true }),
      });
      await expect(row).toBeVisible();
      await expect(row.getByText("System", { exact: true })).toBeVisible();
    }
  });

  test("create custom role → persists + redirects to editor", async ({
    adminPage,
  }) => {
    await adminPage.goto("/settings/roles");

    const suffix = crypto.randomBytes(3).toString("hex");
    const roleName = `${scratchPrefix}${suffix}`;

    await adminPage.getByRole("button", { name: /new role/i }).click();
    const dialog = adminPage.getByRole("dialog", {
      name: /create custom role/i,
    });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel(/^name$/i).fill(roleName);
    await dialog
      .getByRole("textbox", { name: /description/i })
      .fill("E2E-generated role — safe to delete");

    await dialog.getByRole("button", { name: /^create$/i }).click();

    // After create, the client redirects to /settings/roles/{id} —
    // the editor page. Wait for that URL shape before asserting.
    await adminPage.waitForURL(/\/settings\/roles\/[0-9a-f-]{36}/, {
      timeout: 10_000,
    });

    // Now navigate back to the list; the new role must be listed as
    // "Custom" (not System).
    await adminPage.goto("/settings/roles");
    const row = adminPage.locator("tr", {
      has: adminPage.getByRole("link", { name: roleName }),
    });
    await expect(row).toBeVisible();
    await expect(row.getByText("Custom", { exact: true })).toBeVisible();
  });
});
