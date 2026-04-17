import { test, expect } from "../fixtures/base";

/**
 * Users list (/users).
 *
 * Strategy: spin up a scratch user with a deterministic username so the
 * search-filter test has a known row to find. The `_e2e_` prefix makes
 * the row trivially unique in a real DB and avoids collisions with the
 * seeded root admin.
 */

test.describe("users list", () => {
  test("page loads with toolbar + data table", async ({ adminPage }) => {
    await adminPage.goto("/users");
    await expect(
      adminPage.getByRole("heading", { name: /^users$/i }),
    ).toBeVisible();
    await expect(
      adminPage.getByPlaceholder(/search by username, email/i),
    ).toBeVisible();

    // Column headers we care about — every user row has these.
    // They're rendered as buttons (sort headers) or plain cells.
    for (const header of ["User", "Role", "Status", "Balance", "Registered"]) {
      await expect(
        adminPage.getByRole("columnheader", { name: header }).first(),
      ).toBeVisible();
    }
  });

  test("search filters results to the scratch user", async ({
    adminPage,
    makeScratchUser,
  }) => {
    const user = await makeScratchUser();

    await adminPage.goto("/users");

    // 300ms debounce in DataTableToolbar — typing and then waiting for
    // the first navigation + a new server render is enough, but we
    // use pressSequentially to mimic a human.
    const search = adminPage.getByPlaceholder(/search by username, email/i);
    await search.fill(user.username);

    // Wait until the URL reflects the new search param (post-debounce).
    await adminPage.waitForURL(
      (url) => url.searchParams.get("search") === user.username,
      { timeout: 10_000 },
    );

    // The row for our scratch user must now appear. Use email — it's
    // globally unique and appears in the "User" cell's subtitle.
    const row = adminPage.locator("tr", { hasText: user.email });
    await expect(row).toBeVisible();

    // And the status cell should say "active" for a fresh, unlocked
    // non-banned user.
    await expect(row.getByText("active", { exact: true })).toBeVisible();
  });

  test("click a user row → /users/[id]", async ({
    adminPage,
    makeScratchUser,
  }) => {
    const user = await makeScratchUser();

    await adminPage.goto(`/users?search=${encodeURIComponent(user.username)}`);
    await adminPage.waitForURL(
      (url) => url.searchParams.get("search") === user.username,
    );

    const row = adminPage.locator("tr", { hasText: user.email });
    await expect(row).toBeVisible();
    await row.click();

    await adminPage.waitForURL(
      (url) => url.pathname === `/users/${user.id}`,
      { timeout: 15_000 },
    );

    // The detail hero echoes the username — confirm we actually landed
    // on the right user's page and not a navigation mismatch.
    await expect(
      adminPage.getByRole("heading", { name: user.username }),
    ).toBeVisible();
  });

  test("Registered column is date + time, not just date", async ({
    adminPage,
    makeScratchUser,
  }) => {
    const user = await makeScratchUser();

    await adminPage.goto(`/users?search=${encodeURIComponent(user.username)}`);
    await adminPage.waitForURL(
      (url) => url.searchParams.get("search") === user.username,
    );

    const row = adminPage.locator("tr", { hasText: user.email });
    await expect(row).toBeVisible();

    // formatDateTime → "MMM d, yyyy HH:mm" — e.g. "Apr 17, 2026 12:34".
    // The regex is intentionally loose because locale might change the
    // month abbreviation; the "HH:mm" part is what distinguishes this
    // from the date-only formatter.
    const lastCell = row.locator("td").last();
    const cellText = (await lastCell.innerText()).trim();
    expect(cellText).toMatch(/\d{1,2}:\d{2}$/);
  });
});
