import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // @clickhouse/client is a Node-native client (http/https, streams). Keep it
  // external so the bundler doesn't try to bundle it into server output. Inert
  // until the ClickHouse read layer is actually imported by a query path.
  serverExternalPackages: ["@clickhouse/client"],
  turbopack: {
    root: __dirname,
  },
  experimental: {
    staleTimes: {
      // Client Router Cache reuse window. Raised 30 → 120 so navigating BACK
      // to an already-viewed tab / period / list within ~2 min serves the
      // cached RSC payload instantly (no server round-trip, no skeleton).
      // Safe because: server data caches run 60–300s anyway, and any mutation
      // path calls revalidatePath()/router.refresh() which busts this cache —
      // so 2-min staleness only applies to passive back-navigation.
      dynamic: 120,
      static: 180,
    },
    // Barrel-file tree-shake hint for packages we pull many small exports
    // from. Next applies this automatically for a curated list, but calling
    // it out here keeps it explicit and future-proofs against regressions.
    optimizePackageImports: [
      "lucide-react",
      "date-fns",
      "recharts",
      "@tanstack/react-table",
    ],
  },
  async redirects() {
    return [
      {
        source: "/raffles",
        destination: "/rewards",
        permanent: true,
      },
      {
        source: "/raffles/:id",
        destination: "/rewards",
        permanent: true,
      },
      {
        source: "/rewards/raffles",
        destination: "/rewards",
        permanent: true,
      },
      {
        source: "/rewards/raffles/:id",
        destination: "/rewards",
        permanent: true,
      },
      {
        // The race surface was consolidated into /rewards/leaderboards (the
        // wager/race standings board); the old /rewards/races page no longer
        // exists. Retarget the legacy /races deep-link to the live route so
        // bookmarks keep resolving.
        source: "/races",
        destination: "/rewards/leaderboards",
        permanent: true,
      },
      {
        // System Edge Plan v1 was replaced by Edge Plan 2.0, which was itself
        // removed in the 2026-06-15 Insights IA restructure. Point the legacy
        // v1 bookmark straight at /analytics (the merged Insights Overview
        // content — see the 2026-07 Real Numbers merge note below), avoiding
        // a double hop through the now-removed /insights/edge-plan-2.
        source: "/insights/system-edge-plan",
        destination: "/analytics",
        permanent: true,
      },
      // ── Retired-route legacy bookmarks (in-render redirect() → HTTP 308) ──
      // These routes were Server Components whose only job was an
      // unconditional in-render `redirect()`. An unconditional `redirect()`
      // evaluated during the INITIAL load is streamed to the client and
      // replayed by Next's App Router, which changes the hook count of Next's
      // internal `<Router>` useMemo on the post-redirect render → "Rendered
      // more hooks than during the previous render." (plus a cascade of
      // base-ui `useId` hydration attribute mismatches on the page it lands
      // on). Resolving them at the HTTP layer (308), before any React renders,
      // removes the trigger entirely. Same pattern as the retirements above.
      // NOTE: only routes with a FIXED destination are listed here; retired
      // routes whose redirect target depends on a query/param/DB lookup
      // (/insights/rewards/signup, /rewards/analytics, /analytics/pure-pnl,
      // /creators/codes/:code) keep their in-render redirect — a static config
      // redirect can't reproduce a dynamic destination.
      {
        // Alerts moved to the right-rail dock (`DockedAlerts`).
        source: "/creator-hub/alerts",
        destination: "/creator-hub",
        permanent: true,
      },
      {
        // Codes & Ads marketing surfaces live on the main admin dashboard.
        source: "/creator-hub/codes-ads",
        destination: "/creators",
        permanent: true,
      },
      {
        source: "/creator-hub/codes-ads/ads/:code",
        destination: "/creators",
        permanent: true,
      },
      {
        // Legacy games insights — superseded by /ggr.
        source: "/insights/games",
        destination: "/analytics",
        permanent: true,
      },
      {
        // Legacy balance-adjustments insights — removed from the dashboard.
        source: "/insights/balance-adjustments",
        destination: "/analytics",
        permanent: true,
      },
      // ── Insights IA restructure (2026-06-15) ──────────────────────────────
      // The standalone /insights hub page was removed and "Real Numbers"
      // became the Insights landing/overview. These pages were deleted
      // entirely (per owner): analytics, GGR breakdown, challenges insights,
      // Edge Plan 2.0, Wager Liability. Cost Breakdown's ROUTE is KEPT (no
      // nav entry; reachable via a link on the Overview page). Every deleted
      // route 308-redirects to the new Insights Overview so bookmarks/links
      // never 404. HTTP 308 (config redirect), NOT an in-render redirect():
      // an unconditional in-render redirect on the initial document load is
      // replayed by the App Router and crashes it (see the retired-route note
      // above). All have FIXED destinations, so the static config form is
      // correct here.
      //
      // ── Real Numbers merge (2026-07) ──────────────────────────────────────
      // /insights/real-numbers itself was then merged into /analytics's
      // Overview tab (owner-approved): the GGR/NGR/reward-cost waterfall +
      // the deposit-cadence "Analytics" tab content now live there
      // (owner-only), and the Player CRM tab was dropped entirely ("remove
      // CRM, its useless" — not migrated anywhere). Every redirect below that
      // used to target /insights/real-numbers now targets /analytics
      // directly, and the old route itself 308s there too.
      {
        // Old Insights hub page → /analytics (the merged Insights Overview
        // content now lives in the Overview tab there).
        source: "/insights",
        destination: "/analytics",
        permanent: true,
      },
      {
        source: "/insights/analytics",
        destination: "/analytics",
        permanent: true,
      },
      {
        // GGR breakdown page removed.
        source: "/ggr",
        destination: "/analytics",
        permanent: true,
      },
      {
        // Insights challenges analytics removed (the CRUD /challenges page
        // under Rewards is unaffected).
        source: "/insights/challenges",
        destination: "/analytics",
        permanent: true,
      },
      {
        source: "/insights/edge-plan-2",
        destination: "/analytics",
        permanent: true,
      },
      {
        source: "/insights/wager-liability",
        destination: "/analytics",
        permanent: true,
      },
      {
        // /insights/real-numbers itself was deleted (merged into /analytics's
        // Overview tab, 2026-07) — 308 old bookmarks/links straight there.
        source: "/insights/real-numbers",
        destination: "/analytics",
        permanent: true,
      },
      {
        // Legacy ads list + ad-detail — roster lives on /creators.
        source: "/creators/ads",
        destination: "/creators",
        permanent: true,
      },
      {
        source: "/creators/ads/:code",
        destination: "/creators",
        permanent: true,
      },
      {
        // Legacy affiliate-codes list — roster lives on /creators.
        source: "/creators/codes",
        destination: "/creators",
        permanent: true,
      },
      {
        // Legacy gift-cards list — removed from the dashboard; /rewards
        // gates access itself.
        source: "/gift-cards",
        destination: "/rewards",
        permanent: true,
      },
      {
        // The withdrawals list was consolidated into the unified
        // Transactions page. Next forwards incoming query params that the
        // destination doesn't use, so deep-links like
        // /withdrawals?status=pending keep their filters (param names —
        // status / method / minValue / maxValue / search — are identical on
        // both surfaces). `source` matches exactly, so this cannot swallow
        // /withdrawals/:id (live detail route).
        source: "/withdrawals",
        destination: "/transactions/deposits?tab=withdrawals",
        permanent: true,
      },
      {
        // Roles & Permissions was merged into /admin-users as an admin-only
        // tab ("Admins & Access"). The old standalone /settings/roles index
        // page is gone — forward bookmarks + role presets to the merged tab.
        // HTTP 308 (config redirect), NOT an in-render redirect(): an
        // unconditional in-render redirect on the initial document load is
        // replayed by the App Router and crashes it (see the retired-route
        // note above). `source` matches exactly so it cannot swallow the
        // relocated editor route below.
        source: "/settings/roles",
        destination: "/admin-users?tab=roles",
        permanent: true,
      },
      {
        // The custom-role editor relocated from /settings/roles/[id] to
        // /admin-users/roles/[id]. Keep deep-links to a specific role working.
        source: "/settings/roles/:id",
        destination: "/admin-users/roles/:id",
        permanent: true,
      },
      {
        // Pack Transactions was merged into /packs as a switch tab ("Catalog"
        // | "Transactions"). The old standalone /transactions/packs page is
        // gone — forward bookmarks + role presets to the Transactions tab.
        // HTTP 308 (config redirect), NOT an in-render redirect(): an
        // unconditional in-render redirect on the initial document load is
        // replayed by the App Router and crashes it (see the retired-route
        // note above). `source` matches exactly; the live transaction-detail
        // route lives at /transactions/[id] (not nested under packs), so this
        // cannot swallow it. Next forwards incoming query params, so deep-links
        // keep their search/sort.
        source: "/transactions/packs",
        destination: "/packs?tab=transactions",
        permanent: true,
      },
      {
        // Upgrader Transactions was merged into /upgrader as a switch tab
        // ("Catalog" | "Transactions"). Same rationale as the pack-transactions
        // redirect above. `source` matches exactly; the detail route lives at
        // /transactions/[id], so this cannot swallow it.
        source: "/transactions/upgrader",
        destination: "/upgrader?tab=transactions",
        permanent: true,
      },
      {
        // Player CRM was folded into the (owner-only) Insights Overview as a
        // tab, then DROPPED ENTIRELY in the 2026-07 Real Numbers merge (owner:
        // "remove CRM, its useless" — not migrated anywhere). The old
        // standalone /crm page and the ?tab=crm param are both gone — forward
        // bookmarks to plain /analytics rather than a dead param. HTTP 308
        // (config redirect), NOT an in-render redirect(): an unconditional
        // in-render redirect on the initial document load is replayed by the
        // App Router and crashes it (see the retired-route note above).
        source: "/crm",
        destination: "/analytics",
        permanent: true,
      },
    ];
  },
};

// Sentry build integration (source-map upload, auto-instrumentation) only runs
// when configured, so a build without SENTRY_* env is byte-identical to before.
// Runtime error/perf capture is driven by src/instrumentation*.ts regardless;
// this wrapper adds source maps + release tagging when the owner sets env.
const sentryEnabled =
  Boolean(process.env.SENTRY_DSN) || Boolean(process.env.SENTRY_AUTH_TOKEN);

export default sentryEnabled
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
      widenClientFileUpload: true,
      disableLogger: true,
      // Skip source-map upload unless an auth token is present.
      sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
    })
  : nextConfig;
