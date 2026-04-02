import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
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
