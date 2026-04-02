"use client";

import Aurora from "@/components/Aurora";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-4">
      <div className="absolute inset-0">
        <Aurora
          colorStops={["#00A1FF", "#003366", "#00A1FF"]}
          amplitude={1.2}
          blend={0.6}
          speed={0.5}
        />
      </div>
      <div className="relative z-10">{children}</div>
    </div>
  );
}
