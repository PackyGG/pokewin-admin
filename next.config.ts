import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
        destination: "/rewards/raffles",
        permanent: true,
      },
      {
        source: "/raffles/:id",
        destination: "/rewards/raffles/:id",
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
        // System Edge Plan v1 was replaced by Edge Plan 2.0. Keep bookmarks
        // and role presets that still reference the old route working.
        source: "/insights/system-edge-plan",
        destination: "/insights/edge-plan-2",
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
        destination: "/ggr",
        permanent: true,
      },
      {
        // Legacy balance-adjustments insights — removed from the dashboard.
        source: "/insights/balance-adjustments",
        destination: "/insights/analytics",
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
    ];
  },
};

export default nextConfig;
