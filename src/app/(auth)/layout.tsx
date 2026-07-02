"use client";

import Aurora from "@/components/Aurora";
import { DiamondGrid, SparkleField } from "@/components/decor";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <div className="absolute inset-0">
        <Aurora
          colorStops={["#00A1FF", "#003366", "#00A1FF"]}
          amplitude={1.2}
          blend={0.6}
          speed={0.5}
        />
      </div>
      {/* Liquid-Glass ornaments over the aurora backdrop:
          - SparkleField: warm champagne 4-point glints fading radially
            from the top-right corner (the owner-reference treatment).
          - DiamondGrid: a diamond checkerboard anchored bottom-left,
            fading out along the diagonal.
          Both are single pattern-based SVGs, aria-hidden and
          pointer-events-none; tints are theme-aware (faint primary/ink
          in light mode, champagne/white on dark). */}
      <SparkleField className="inset-y-0 right-0 w-[42rem] max-w-full text-primary/[0.08] dark:text-amber-100/20" />
      <DiamondGrid className="bottom-0 left-0 h-80 w-[28rem] max-w-full text-foreground/[0.06] [mask-image:linear-gradient(45deg,black,transparent_75%)] dark:text-white/[0.14]" />
      <div className="relative z-10">{children}</div>
    </div>
  );
}
