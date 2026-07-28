"use client";

/**
 * Slim "Live" chip for the dashboard hero row. The dashboard silently
 * `router.refresh()`es every 60s (see AutoRefresh); this makes that
 * freshness visible so operators know the board self-updates and don't
 * hard-reload. Flat chrome: hairline border, muted text, one pulsing
 * emerald dot (motion-safe only).
 */
export function LiveIndicator() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium text-muted-foreground">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full rounded-full bg-emerald-400/60 motion-safe:animate-ping" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
      </span>
      Live · refreshes every 60s
    </span>
  );
}
