import { TriangleAlert } from "lucide-react";

/**
 * Thin red strip rendered at the very top of the admin shell when
 * the current session is routed at the DEV Main-DB. Purely visual —
 * the actual routing is in @/lib/db. The banner is rendered from the
 * layout Server Component, so it shows up on every admin page without
 * needing to remember to opt in.
 */
export function DevDbBanner() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-50 flex items-center justify-center gap-2 border-b border-rose-500/40 bg-rose-600/90 px-3 py-1.5 text-xs font-medium text-white shadow-sm backdrop-blur dark:bg-rose-600/80"
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      <span className="truncate">
        You are connected to the DEV environment — changes here do not affect
        production.
      </span>
    </div>
  );
}
