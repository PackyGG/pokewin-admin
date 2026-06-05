import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import {
  detectOffenders,
  DEFAULT_DETECT_OPTIONS,
  type DetectOptions,
  type DetectResult,
  type Offender,
} from "./detect";
import { SESSION_COOKIE_NAME } from "./mint-session";
import { viewportLabel, type AuditRoute, type Viewport } from "./config";

/**
 * Reusable runner for the responsive audit. The Wave 0 spec uses it to
 * prove the /users/[id] break + verify the fix; later waves import
 * `auditRoutes` with their own route arrays.
 */

export const ARTIFACT_DIR = resolve(process.cwd(), "audit-artifacts");

export type RouteViewportResult = {
  routeKey: string;
  path: string;
  viewport: Viewport;
  result: DetectResult;
  screenshotPath: string | null;
};

/**
 * Inject the minted admin_session cookie into a context. Mirrors the
 * cookie attributes src/lib/session.ts sets at login (httpOnly, path "/",
 * sameSite lax) but with secure:false because the dev server is http on
 * localhost. domain is localhost so it rides every same-origin nav.
 */
export async function injectSessionCookie(
  context: BrowserContext,
  cookieValue: string,
  baseURL: string,
): Promise<void> {
  const host = new URL(baseURL).hostname; // "localhost"
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: cookieValue,
      domain: host,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

/**
 * Seed client-side localStorage BEFORE the app's React mounts, so the
 * admin shell renders in a state suitable for measuring PAGE CONTENT
 * layout rather than persistent chrome:
 *
 *   - The three right-edge docked widgets (live / recent / chat — see
 *     src/components/right-rail-context.tsx) DEFAULT to `live+chat open`.
 *     They are `position: fixed` panels that, on a phone-width viewport,
 *     blanket the screen and sit ON TOP of the page content. For a
 *     content-layout audit we collapse all three (storage value "0") so
 *     the hero/body is the measurement target. (The dock-open states are
 *     audited separately + explicitly only on the dock-reserving pages.)
 *
 * Uses the EXACT storage keys the context reads (STORAGE_KEYS) so this is
 * a faithful "user collapsed the panels" state, not a hack.
 */
export async function seedCollapsedRail(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("live-money-chat:open", "0");
      window.localStorage.setItem("docked-recent-activity:open", "0");
      window.localStorage.setItem("docked-chat:open", "0");
      window.localStorage.setItem("right-rail:open-order", "[]");
    } catch {
      /* localStorage unavailable — non-fatal */
    }
  });
}

/**
 * Sanity check: with the cookie injected, /dashboard must render and NOT
 * bounce to /login. A bounce means the minted cookie didn't satisfy
 * middleware (wrong SESSION_SECRET, payload shape, or expiry) — fail loud
 * so we never silently audit the login page for every route.
 */
export async function assertAuthenticated(page: Page): Promise<void> {
  const resp = await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  // Give any client redirect a beat to settle. The middleware redirect to
  // /login (if the cookie were rejected) is a server 307, so by the time
  // goto resolves the URL already reflects the final destination.
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  const url = page.url();
  if (/\/login(\?|$)/.test(url)) {
    throw new Error(
      `[responsive] Auth sanity check FAILED: /dashboard redirected to ${url}. ` +
        `The minted admin_session cookie was rejected by middleware — check ` +
        `SESSION_SECRET + payload shape against src/lib/session.ts.`,
    );
  }
  if (resp && resp.status() >= 400) {
    throw new Error(
      `[responsive] Auth sanity check FAILED: /dashboard returned HTTP ${resp.status()}.`,
    );
  }
}

/**
 * Settle a freshly-navigated page so we measure the REAL layout, not a
 * mid-stream skeleton.
 *
 * Deliberately NOT `networkidle`: this app has live-polling endpoints
 * (/api/packy-live, /api/live/activity) that can take 10s+ and never let
 * the network go idle, so waiting on it just times out. Instead we:
 *   1. wait for DOM content,
 *   2. wait for any Suspense skeleton (aria-busy / .animate-pulse) to clear
 *      — the user-detail hero streams in behind a Suspense boundary,
 *   3. wait two animation frames for layout + the FadeIn to settle.
 */
async function settlePage(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  // Wait until the streamed body has replaced its skeleton. The skeletons
  // use animate-pulse and/or aria-busy; once none remain the hero is real.
  await page
    .waitForFunction(
      () => {
        const busy = document.querySelector('[aria-busy="true"]');
        const pulsing = document.querySelector(".animate-pulse");
        return !busy && !pulsing;
      },
      { timeout: 12_000 },
    )
    .catch(() => undefined);
  // Two RAFs: one for layout, one for the keyed FadeIn transition to land.
  await page
    .evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
        ),
    )
    .catch(() => undefined);
}

/**
 * Warm a route once (Turbopack compiles a route lazily on first hit; a
 * cold-compile mid-measure can look like a layout break — content shifting
 * while chunks stream). After this returns the route is compiled + cached.
 */
async function warmRoute(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await settlePage(page);
}

/**
 * Draw a red box over the worst offender (and a softer box over the
 * sibling-overlap partner) so the artifact screenshot points a human
 * straight at the problem. Boxes are removed after the screenshot.
 */
async function captureWithBox(
  page: Page,
  worst: Offender | null,
  filePath: string,
): Promise<void> {
  if (worst) {
    await page.evaluate((o) => {
      const mk = (
        r: { x: number; y: number; width: number; height: number },
        color: string,
      ) => {
        const box = document.createElement("div");
        box.setAttribute("data-audit-box", "1");
        box.style.position = "absolute";
        box.style.left = `${r.x + window.scrollX}px`;
        box.style.top = `${r.y + window.scrollY}px`;
        box.style.width = `${r.width}px`;
        box.style.height = `${r.height}px`;
        box.style.border = `3px solid ${color}`;
        box.style.boxShadow = `0 0 0 3px ${color}55`;
        box.style.zIndex = "2147483647";
        box.style.pointerEvents = "none";
        box.style.borderRadius = "4px";
        document.body.appendChild(box);
      };
      mk(o.rect, "#ef4444");
      if (o.other) mk(o.other.rect, "#f59e0b");
    }, worst);
  }
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => undefined);
  await page
    .evaluate(() => {
      document
        .querySelectorAll("[data-audit-box]")
        .forEach((n) => n.remove());
    })
    .catch(() => undefined);
}

/**
 * Audit a single route across a set of viewports on an already-warmed page.
 * Returns one result per viewport.
 */
export async function auditRouteOnPage(
  page: Page,
  route: AuditRoute,
  resolvedPath: string,
  viewports: Viewport[],
  opts: DetectOptions = DEFAULT_DETECT_OPTIONS,
): Promise<RouteViewportResult[]> {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const results: RouteViewportResult[] = [];

  // Warm once at a desktop size so the route is compiled before we start
  // shrinking the viewport.
  await page.setViewportSize({ width: 1280, height: 900 });
  await warmRoute(page, resolvedPath);

  for (const vp of viewports) {
    await page.setViewportSize(vp);
    // Re-navigate so the server renders fresh for this width. The route is
    // already compiled (warmRoute above), so this is a hot load. We settle
    // on DOM + skeleton-clear rather than networkidle (live-poll endpoints
    // never let the network idle on this app).
    await page.goto(resolvedPath, { waitUntil: "domcontentloaded" });
    await settlePage(page);

    const result = (await page.evaluate(detectOffenders, opts)) as DetectResult;

    const worst = result.offenders.length > 0 ? result.offenders[0] : null;
    const fileName = `${route.key}__${viewportLabel(vp)}.png`;
    const filePath = resolve(ARTIFACT_DIR, fileName);
    await captureWithBox(page, worst, filePath);

    results.push({
      routeKey: route.key,
      path: resolvedPath,
      viewport: vp,
      result,
      screenshotPath: filePath,
    });
  }

  return results;
}

/** Pretty one-liner for logs. */
export function summarizeResult(r: RouteViewportResult): string {
  const { result, viewport } = r;
  const tag =
    result.gatingCount > 0
      ? `GATING×${result.gatingCount}`
      : result.warnCount > 0
        ? `warn×${result.warnCount}`
        : "clean";
  return `${r.routeKey} @ ${viewportLabel(viewport)} → ${tag} (sw ${result.scrollWidth}/${result.innerWidth})`;
}

/** Write a JSON report of all results into the artifact dir. */
export function writeReport(
  name: string,
  results: RouteViewportResult[],
): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const path = resolve(ARTIFACT_DIR, name);
  writeFileSync(path, JSON.stringify(results, null, 2), "utf8");
  return path;
}
