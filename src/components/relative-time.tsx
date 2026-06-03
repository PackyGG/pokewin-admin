"use client";

import * as React from "react";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { useMounted } from "@/hooks/use-mounted";

/**
 * Drop-in replacement for inlining `formatRelative(date)` inside a client
 * component's JSX.
 *
 * WHY THIS EXISTS — `formatRelative` ("2 minutes ago") is computed against
 * `Date.now()`. A client component is also rendered to HTML on the server, so
 * the server formats the phrase against the SERVER clock and the first client
 * paint re-formats it against the CLIENT clock a moment later. Near any
 * rounding boundary the two strings differ, and React treats that as a
 * hydration mismatch — surfaced as the minified **React error #418** in
 * production. `suppressHydrationWarning` only hides the dev warning; the
 * recoverable error is still logged in prod, so it is not a real fix.
 *
 * HOW IT FIXES IT — until `mounted` flips (i.e. on the server render AND the
 * first client paint, which must match byte-for-byte) it renders a
 * DETERMINISTIC absolute timestamp in a FIXED zone (UTC — independent of both
 * the server's and the viewer's local zone). Once mounted, it upgrades to the
 * live relative phrase and the absolute timestamp moves to the `title`
 * tooltip. First paint is therefore identical on both sides; the relative
 * label appears one tick later with no mismatch.
 *
 * Use this anywhere a client component would otherwise render
 * `{formatRelative(x)}` in markup that participates in SSR/hydration.
 */
export function RelativeTime({
  date,
  className,
}: {
  date: string | number | Date;
  className?: string;
}) {
  const mounted = useMounted();
  // Absolute, zone-fixed (UTC) timestamp — identical on server + client.
  const absolute = formatDateTime(date, "UTC");
  return (
    <span className={className} title={absolute} suppressHydrationWarning>
      {mounted ? formatRelative(date) : absolute}
    </span>
  );
}
