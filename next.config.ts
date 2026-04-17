import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
        source: "/races",
        destination: "/rewards/races",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
