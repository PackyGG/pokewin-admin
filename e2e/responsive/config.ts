/**
 * Shared configuration for the responsive audit harness.
 *
 * Later waves of the full responsive audit (list pages, analytics, forms,
 * auth) import VIEWPORTS / PRIORITY_VIEWPORTS and add their routes to a
 * spec that reuses runRouteAudit from ./runner. Keeping the matrix here
 * means every wave measures against the same breakpoints.
 */

export type Viewport = { width: number; height: number };

/**
 * The core viewport matrix. Widths span the smallest phone we support
 * (320) through a large desktop (1536), hitting each Tailwind breakpoint:
 *   sm 640 · md 768 · lg 1024 · xl 1280 · 2xl 1536
 * plus the awkward in-between phone/tablet widths where hand-rolled grids
 * tend to break (360 / 390 / 414 / 820).
 */
export const VIEWPORTS: Viewport[] = [
  { width: 320, height: 800 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
  { width: 640, height: 900 },
  { width: 768, height: 1024 },
  { width: 820, height: 1180 },
  { width: 1024, height: 900 },
  { width: 1280, height: 900 },
  { width: 1536, height: 960 },
];

/**
 * Breakpoint-minus-1 widths — the classic "just before the layout
 * switches" trap. Run these on priority/detail pages on top of VIEWPORTS.
 */
export const PRIORITY_VIEWPORTS: Viewport[] = [
  { width: 639, height: 900 },
  { width: 767, height: 1024 },
  { width: 1023, height: 900 },
];

export function viewportLabel(v: Viewport): string {
  return `${v.width}x${v.height}`;
}

/**
 * A route under audit. `path` is resolved at runtime — detail routes use a
 * `:sampleUserId` token replaced with a real id read read-only from the DB.
 */
export type AuditRoute = {
  /** Stable key used in artifact filenames + test titles. */
  key: string;
  /** Path template; `:sampleUserId` / `:sampleCreatorId` substituted at runtime. */
  path: string;
  /** Whether to also run PRIORITY_VIEWPORTS for this route. */
  priority?: boolean;
  /** Needs a real entity id substituted into the path. */
  needsSampleUser?: boolean;
  /** Needs a creator-role user id (Hub detail routes). */
  needsSampleCreator?: boolean;
};

/**
 * Wave 0 scope: the single proven-break hero — /users/[id]'s hand-rolled
 * hero in user-view-modern.tsx.
 *
 * It is audited via the DEV-ONLY rendering fixture at
 * /responsive-fixture/users-detail rather than the live /users/[id]
 * route, because the live route's hero only renders when the ~19-query
 * getUserDetail aggregate succeeds against the MAIN game DB — which throws
 * (and degrades to a "details failed" banner, hiding the hero) on any
 * environment whose main DB is behind the current Prisma schema. The
 * fixture renders the EXACT production <UserViewModern> component with a
 * representative payload, so the detector is validated against the real
 * hero markup independent of main-DB schema drift. See
 * src/app/_responsive-fixture/users-detail/page.tsx.
 *
 * Later waves audit their real list/analytics/form routes directly (those
 * don't gate the hero on the heavy per-user aggregate) and use the
 * `:sampleUserId` substitution + needsSampleUser for any detail route whose
 * page renders cleanly against the connected DB.
 */
export const WAVE0_ROUTES: AuditRoute[] = [
  {
    key: "users-detail",
    path: "/responsive-fixture/users-detail",
    priority: true,
  },
];

/** Creator Hub routes for the minted-session responsive sweep. */
export const CREATOR_HUB_ROUTES: AuditRoute[] = [
  { key: "hub-dashboard", path: "/creator-hub", priority: true },
  { key: "hub-creators", path: "/creator-hub/creators", priority: true },
  {
    key: "hub-creator-detail",
    path: "/creator-hub/creators/:sampleCreatorId",
    priority: true,
    needsSampleCreator: true,
  },
  {
    key: "hub-creator-forecast",
    path: "/creator-hub/creators/:sampleCreatorId?tab=forecast",
    needsSampleCreator: true,
  },
  { key: "hub-leaderboards", path: "/creator-hub/leaderboards" },
  { key: "hub-creator-check", path: "/creator-hub/creator-check" },
  { key: "hub-acquisition", path: "/creator-hub/acquisition" },
  { key: "hub-socials-review", path: "/creator-hub/socials-review" },
  { key: "hub-profitable-algo", path: "/creator-hub/profitable-algo" },
  { key: "hub-changelog", path: "/creator-hub/changelog" },
  { key: "hub-deal-tracker", path: "/creator-hub/deal-tracker" },
  { key: "hub-compare", path: "/creator-hub/compare" },
  { key: "hub-settings", path: "/creator-hub/settings" },
  { key: "hub-alerts-redirect", path: "/creator-hub/alerts" },
];
