"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/**
 * Client-side redirect for the legacy `/rewards/analytics` stub.
 *
 * Why this instead of an in-render server `redirect()` or a static
 * `next.config.ts` 308:
 *   - An in-render `redirect()` on first document load crashes Next's App
 *     Router ("Rendered more hooks than during the previous render", React
 *     error #310/#418) during the transition — the documented
 *     "in-render redirect → Router crash" class.
 *   - A static 308 can't be used here because the destination is DYNAMIC:
 *     `?category=` maps to 7 different `/insights/rewards/<sub>` targets and
 *     `?period=` is remapped (e.g. `today` → `24h`). A fixed redirect would
 *     break those deep-links.
 *
 * The server component computes the exact destination from `searchParams`
 * and passes it here as a plain serializable string (no function props over
 * the RSC boundary — Next 15 crashes on those). We perform the navigation in
 * an effect with `router.replace` so it runs after hydration, not during
 * render — which is what avoids the hook-count crash.
 */
export function RewardsAnalyticsClientRedirect({ dest }: { dest: string }) {
  const router = useRouter();

  React.useEffect(() => {
    router.replace(dest);
  }, [dest, router]);

  return null;
}
