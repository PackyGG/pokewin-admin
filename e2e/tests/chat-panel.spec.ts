import { test, expect } from "../fixtures/base";

/**
 * Chat panel (slide-out sheet mounted in every admin page).
 *
 * The panel is triggered by a floating action button in the bottom-right
 * and swaps between Chat and Mutes tabs. We don't probe the chat feed
 * itself — that's another agent's territory — only the panel shell.
 */

test.describe("chat panel", () => {
  test("floating FAB opens the sheet with Chat + Mutes tabs", async ({
    adminPage,
  }) => {
    await adminPage.goto("/dashboard");

    // The button has aria-label "Open chat and mutes panel".
    const fab = adminPage.getByRole("button", {
      name: /open chat and mutes panel/i,
    });
    await expect(fab).toBeVisible();

    await fab.click();

    // Sheet opens — the sticky header reads "Chat & Mutes" and exposes
    // Chat/Mutes tabs via TabsTrigger.
    await expect(
      adminPage.getByRole("heading", { name: /chat & mutes/i }),
    ).toBeVisible();

    const chatTab = adminPage.getByRole("tab", { name: /^chat$/i });
    const mutesTab = adminPage.getByRole("tab", { name: /^mutes$/i });
    await expect(chatTab).toBeVisible();
    await expect(mutesTab).toBeVisible();

    // Chat is selected first.
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(mutesTab).toHaveAttribute("aria-selected", "false");
  });

  test("switching to Mutes updates aria-selected", async ({ adminPage }) => {
    await adminPage.goto("/dashboard");
    await adminPage
      .getByRole("button", { name: /open chat and mutes panel/i })
      .click();

    const mutesTab = adminPage.getByRole("tab", { name: /^mutes$/i });
    await mutesTab.click();
    await expect(mutesTab).toHaveAttribute("aria-selected", "true");

    const chatTab = adminPage.getByRole("tab", { name: /^chat$/i });
    await expect(chatTab).toHaveAttribute("aria-selected", "false");
  });

  test("Escape closes the panel", async ({ adminPage }) => {
    await adminPage.goto("/dashboard");
    await adminPage
      .getByRole("button", { name: /open chat and mutes panel/i })
      .click();

    const header = adminPage.getByRole("heading", { name: /chat & mutes/i });
    await expect(header).toBeVisible();

    await adminPage.keyboard.press("Escape");

    // The sheet unmounts its content when closed (ChatPanel.tsx gates the
    // inner tree on `open`) — the header should disappear.
    await expect(header).not.toBeVisible();
  });
});
