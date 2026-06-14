import { test, expect } from "@playwright/test";
import { SESSION_COOKIE_NAME, mintAdminSession } from "./mint-session";

/**
 * Verification for the UserHeroSticky scroll-collapse bar against the REAL
 * inner-scroll geometry of the admin shell.
 *
 * Uses the dev-only fixture /responsive-fixture/users-detail-scroll, which
 * renders the production <UserViewModern> (containing UserHeroSticky) inside
 * a fixed-height `[data-admin-scroll]` overflow-auto container — the exact
 * environment where the owner reported the condensed bar never appearing.
 * (The real /users/[id] route degrades locally because its ~19-query MAIN-DB
 * aggregate throws against the drifted local prod DB; the fixture renders the
 * identical component with static data, so this isolates the scroll behaviour
 * from DB availability.)
 *
 * Asserts: hidden at top → visible (opacity ~1, pointer-events auto, shows
 * name + balance) after scrolling the inner container past the hero → hidden
 * again after scrolling back to top.
 */

const FIXTURE = "/responsive-fixture/users-detail-scroll";

test("hero condensed bar shows on scroll inside inner overflow-auto container", async ({
  page,
  context,
}) => {
  // Middleware redirects all non-public routes (incl. the dev fixture) to
  // /login without a session, so mint the same admin_session cookie the
  // responsive harness uses (read-only admin from the ADMIN DB).
  const { cookieValue } = await mintAdminSession();
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

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  expect(page.url(), "should not redirect to login").not.toContain("/login");

  const scroller = page.locator("[data-admin-scroll]");
  await scroller.first().waitFor({ state: "attached", timeout: 30_000 });
  await expect(scroller).toHaveCount(1);

  // The condensed bar is the position:sticky element resolving to top:0px
  // inside the scroll container (the tab bar is top:3.25rem so it won't match).
  const probe = `
    (() => {
      const el = document.querySelector("[data-admin-scroll]");
      if (!el) return null;
      const stickies = Array.from(el.querySelectorAll("*")).filter(
        (n) => getComputedStyle(n).position === "sticky"
      );
      const bar = stickies.find((n) => getComputedStyle(n).top === "0px") || null;
      if (!bar) return { found: false, stickyCount: stickies.length };
      const cs = getComputedStyle(bar);
      return {
        found: true,
        opacity: cs.opacity,
        pointerEvents: cs.pointerEvents,
        text: (bar.textContent || "").trim(),
        rectTop: Math.round(bar.getBoundingClientRect().top),
      };
    })()
  `;

  const atTop = (await page.evaluate(probe)) as {
    found: boolean;
    opacity?: string;
    pointerEvents?: string;
  } | null;
  console.log("[hero-sticky] at top:", JSON.stringify(atTop));
  expect(atTop?.found, "condensed bar element exists").toBe(true);
  expect(Number(atTop!.opacity), "hidden at top").toBeLessThan(0.5);
  expect(atTop!.pointerEvents, "non-interactive at top").toBe("none");

  // Scroll the INNER overflow-auto container down past the hero and HOLD it
  // (a one-shot scrollTop was being reset by a late layout pass, so we poll +
  // re-pin). 900px clears the hero while leaving content below, so the bar's
  // sticky containing block still has room — mirrors the real page.
  const SCROLL_TO = 900;
  await scroller.evaluate((el, top) => {
    (el as HTMLElement).scrollTo({
      top,
      behavior: "instant" as ScrollBehavior,
    });
  }, SCROLL_TO);
  // Poll until the IntersectionObserver has fired and the bar is shown, while
  // keeping the scroll pinned each tick.
  await expect
    .poll(
      async () =>
        scroller.evaluate((el, top) => {
          const e = el as HTMLElement;
          if (Math.abs(e.scrollTop - top) > 4) e.scrollTop = top;
          const root = document.querySelector("[data-admin-scroll]");
          const bar = Array.from(
            root?.querySelectorAll<HTMLElement>("*") ?? [],
          ).find(
            (n) =>
              getComputedStyle(n).position === "sticky" &&
              getComputedStyle(n).top === "0px",
          );
          return bar ? Number(getComputedStyle(bar).opacity) : -1;
        }, SCROLL_TO),
      { timeout: 5000, intervals: [100, 200, 300, 500] },
    )
    .toBeGreaterThan(0.9);
  const scrolled = (await page.evaluate(probe)) as {
    found: boolean;
    opacity?: string;
    pointerEvents?: string;
    text?: string;
    rectTop?: number;
  } | null;
  console.log("[hero-sticky] after scroll:", JSON.stringify(scrolled));
  expect(scrolled?.found, "bar exists after scroll").toBe(true);
  expect(
    Number(scrolled!.opacity),
    "bar should be visible (opacity ~1) after scrolling past hero",
  ).toBeGreaterThan(0.9);
  expect(scrolled!.pointerEvents, "interactive when shown").toBe("auto");
  expect(
    (scrolled!.text ?? "").length,
    "bar shows name + balance text",
  ).toBeGreaterThan(0);
  // Pinned to the top of the scroll container (sticky top-0).
  expect(Math.abs(scrolled!.rectTop ?? 999)).toBeLessThan(40);

  await page.screenshot({
    path: "audit-artifacts/hero-sticky-collapsed.png",
    fullPage: false,
  });

  // Scroll back to top → bar hides again.
  await scroller.evaluate((el) => {
    (el as HTMLElement).scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  });
  await expect
    .poll(
      async () =>
        scroller.evaluate((el) => {
          const e = el as HTMLElement;
          if (e.scrollTop > 4) e.scrollTop = 0;
          const root = document.querySelector("[data-admin-scroll]");
          const bar = Array.from(
            root?.querySelectorAll<HTMLElement>("*") ?? [],
          ).find(
            (n) =>
              getComputedStyle(n).position === "sticky" &&
              getComputedStyle(n).top === "0px",
          );
          return bar ? Number(getComputedStyle(bar).opacity) : -1;
        }),
      { timeout: 5000, intervals: [100, 200, 300, 500] },
    )
    .toBeLessThan(0.5);
});
