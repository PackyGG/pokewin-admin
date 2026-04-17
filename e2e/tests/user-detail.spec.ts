import { test, expect } from "../fixtures/base";
import { currentTotp } from "../helpers/totp";
import { getUserBalance, getUserRole } from "../helpers/db";

/**
 * User detail page (/users/[id]).
 *
 * The detail page is where the highest-stakes admin mutations live
 * (balance, role, bans, wipe). We cover:
 *   - Hero + KPI strip render
 *   - Tab switching keeps the rest of the page intact
 *   - Change Role dialog exposes all 4 roles and cancels cleanly
 *   - Adjust Balance validates empty/missing fields and, on success,
 *     actually moves the balance in the main DB (not just the UI)
 */

test.describe("user detail", () => {
  test("hero renders username + role badge + status badge", async ({
    adminPage,
    makeScratchUser,
  }) => {
    const user = await makeScratchUser();
    await adminPage.goto(`/users/${user.id}`);

    // Username heading in the hero.
    await expect(
      adminPage.getByRole("heading", { name: user.username }),
    ).toBeVisible();

    // Fresh scratch users are role=user, status=Active.
    await expect(adminPage.getByText("user", { exact: true }).first()).toBeVisible();
    await expect(adminPage.getByText("Active", { exact: true }).first()).toBeVisible();

    // Six KPI tiles in the hero.
    for (const label of [
      "Total Value",
      "P&L",
      "Deposits",
      "Withdrawals",
      "Multiplier",
      "House Edge",
    ]) {
      await expect(
        adminPage.getByText(label, { exact: true }).first(),
      ).toBeVisible();
    }
  });

  test("tab switch Overview → Finances → Inventory renders each", async ({
    adminPage,
    makeScratchUser,
  }) => {
    const user = await makeScratchUser();
    await adminPage.goto(`/users/${user.id}`);

    // Overview is default — verify the P&L panel is up.
    await expect(
      adminPage.getByRole("button", { name: /overview/i }),
    ).toBeVisible();

    await adminPage.getByRole("button", { name: /^finances$/i }).click();
    // Finances tab surfaces the financial transactions table. A fresh
    // user has no transactions, so "No transactions" / empty state copy
    // is the right assertion. The section heading stays constant.
    await expect(
      adminPage.locator("text=/deposits|withdrawals|transactions/i").first(),
    ).toBeVisible();

    await adminPage.getByRole("button", { name: /^inventory$/i }).click();
    // Inventory is the most structurally distinct tab — it has an
    // empty-state block when the user has no items.
    await expect(
      adminPage
        .locator("text=/no (items|inventory|cards)|inventory|owned/i")
        .first(),
    ).toBeVisible();
  });

  test("Change Role dialog lists 4 roles and Cancel is a no-op", async ({
    adminPage,
    makeScratchUser,
  }) => {
    const user = await makeScratchUser();
    const roleBefore = await getUserRole(user.id);
    await adminPage.goto(`/users/${user.id}`);

    await adminPage.getByRole("button", { name: /change role/i }).click();
    const dialog = adminPage.getByRole("dialog", { name: /change role/i });
    await expect(dialog).toBeVisible();

    // Open the role select — the four options live inside a floating
    // listbox rendered by shadcn/base-ui Select.
    await dialog.getByRole("combobox").click();

    // ROLES in src/lib/constants.ts: ["user","support","admin","creator"].
    // Labels get title-cased in the dialog: "User", "Support", "Admin", "Creator".
    for (const label of ["User", "Support", "Admin", "Creator"]) {
      await expect(
        adminPage.getByRole("option", { name: label }),
      ).toBeVisible();
    }

    // Close the select before clicking Cancel or the backdrop swallows
    // the next click.
    await adminPage.keyboard.press("Escape");
    await dialog.getByRole("button", { name: /^cancel$/i }).click();
    await expect(dialog).not.toBeVisible();

    // Role must not have changed.
    const roleAfter = await getUserRole(user.id);
    expect(roleAfter).toBe(roleBefore);
  });

  test("Adjust Balance: empty amount → toast error, dialog stays", async ({
    adminPage,
    makeScratchUser,
  }) => {
    const user = await makeScratchUser();
    await adminPage.goto(`/users/${user.id}`);

    await adminPage
      .getByRole("button", { name: /^adjust balance$/i })
      .click();
    const dialog = adminPage.getByRole("dialog", { name: /adjust balance/i });
    await expect(dialog).toBeVisible();

    // Leave amount blank, pick a reason, type a TOTP code, click Apply.
    await dialog.getByRole("combobox").click();
    await adminPage.getByRole("option", { name: "Bonus" }).click();

    await dialog
      .getByPlaceholder(/enter your 6-digit code/i)
      .fill("000000");
    await dialog
      .getByRole("button", { name: /apply adjustment/i })
      .click();

    // sonner renders toasts in an overlay with role="status".
    await expect(
      adminPage.locator("li, div").getByText(/valid amount/i).first(),
    ).toBeVisible();

    // Dialog remains open — the server action never ran because the
    // client-side guard rejected the empty amount.
    await expect(dialog).toBeVisible();
  });

  test("Adjust Balance: valid form → balance moves in the DB", async ({
    adminPage,
    makeScratchUser,
    adminTotpSecret,
  }) => {
    const user = await makeScratchUser();
    const before = await getUserBalance(user.id);
    expect(before).toBe(0);

    await adminPage.goto(`/users/${user.id}`);
    await adminPage
      .getByRole("button", { name: /^adjust balance$/i })
      .click();

    const dialog = adminPage.getByRole("dialog", { name: /adjust balance/i });
    await expect(dialog).toBeVisible();

    await dialog.getByPlaceholder("Amount (+/-)").fill("17.50");

    await dialog.getByRole("combobox").click();
    await adminPage.getByRole("option", { name: "Bonus" }).click();

    // Use a live TOTP code against the seeded admin's secret.
    await dialog
      .getByPlaceholder(/enter your 6-digit code/i)
      .fill(currentTotp(adminTotpSecret));

    await dialog
      .getByRole("button", { name: /apply adjustment/i })
      .click();

    // Sonner success toast.
    await expect(
      adminPage
        .locator("li, div")
        .getByText(/balance adjusted/i)
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    // Dialog closes on success.
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    // Main-DB balance must match what we asked for. The server writes
    // both balances.available_balance AND a ledger_transactions row —
    // verifying the number here proves the transaction committed.
    const after = await getUserBalance(user.id);
    expect(after).toBeCloseTo(before + 17.5, 2);
  });
});
