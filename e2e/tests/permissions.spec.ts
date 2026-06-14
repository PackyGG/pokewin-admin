import crypto from "node:crypto";
import { test, expect } from "../fixtures/base";
import { cleanupE2EAdminRoles, scratchPrefix } from "../helpers/db";

/**
 * Roles & Permissions — the admin-only Roles tab of the merged Admins &
 * Access surface (/admin-users?tab=roles). Custom-role CRUD lives here; the
 * standalone /settings/roles page was merged into /admin-users.
 *
 * Lightweight coverage:
 *   - the merged surface renders with the Roles tab content (Built-in +
 *     Custom Roles sections)
 *   - the legacy /settings/roles route 308-redirects onto the Roles tab
 *   - creating a new custom role persists and redirects to the relocated
 *     editor at /admin-users/roles/{id}
 *
 * After-all sweep wipes any leftover `_e2e_*` custom roles.
 */

test.describe("permissions — admin roles", () => {
  test.afterAll(async () => {
    await cleanupE2EAdminRoles();
  });

  test("legacy /settings/roles redirects onto the merged Roles tab", async ({
    adminPage,
  }) => {
    await adminPage.goto("/settings/roles");
    // 308 config redirect lands on /admin-users?tab=roles.
    await expect(adminPage).toHaveURL(/\/admin-users\?tab=roles/);
    // The merged surface hero + the Roles-tab sections are present.
    await expect(
      adminPage.getByRole("heading", { name: /admins & access/i }),
    ).toBeVisible();
    await expect(
      adminPage.getByRole("heading", { name: /built-in roles/i }),
    ).toBeVisible();
    await expect(
      adminPage.getByRole("heading", { name: /custom roles/i }),
    ).toBeVisible();
  });

  test("create custom role → persists + redirects to editor", async ({
    adminPage,
  }) => {
    await adminPage.goto("/admin-users?tab=roles");

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

    // After create, the client redirects to the relocated editor route
    // /admin-users/roles/{id}. Wait for that URL shape before asserting.
    await adminPage.waitForURL(/\/admin-users\/roles\/[0-9a-f-]{36}/, {
      timeout: 10_000,
    });

    // Back on the Roles tab, the new role must appear as a custom-role card
    // (links into its editor) with the "Editable" badge.
    await adminPage.goto("/admin-users?tab=roles");
    const card = adminPage.locator("a", {
      hasText: roleName,
    });
    await expect(card.first()).toBeVisible();
    await expect(
      adminPage.getByText("Editable", { exact: true }).first(),
    ).toBeVisible();
  });
});
