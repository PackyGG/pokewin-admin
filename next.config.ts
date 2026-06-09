import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  experimental: {
    staleTimes: {
      dynamic: 30,
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
    ];
  },
};

export default nextConfig;
