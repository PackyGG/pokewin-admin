"use client";

import { useLinkStatus } from "next/link";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Route transition treatments  (pokewin-admin · src/components/ux)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Visual "the route is changing" feedback. The app already has a global
 * top-progress bar (`src/components/top-progress-bar.tsx`) that flashes on
 * commit; these add a *pending-state* treatment that fires the moment a
 * navigation is intended (before commit), so slow server renders don't feel
 * like dead clicks.
 *
 * Built on Next.js 15 primitives, with graceful degradation:
 *   - `LinkPending`        → reads `useLinkStatus()` (App Router). MUST be a
 *                            descendant of a `next/link` `<Link>`. Renders a
 *                            small spinner / dims a label only while that link's
 *                            navigation is pending. If the hook ever reports no
 *                            pending state (older runtime / outside a Link), it
 *                            simply never shows — safe no-op.
 *
 * Non-blocking rule: motion is `motion-safe:` gated; reduced-motion users get
 * the opacity change without a transition tween.
 */

// ─── LinkPending ────────────────────────────────────────────────────────────

/**
 * Inline pending indicator for a `<Link>`. Place it inside the link's children
 * (or anywhere in the same React subtree under the `<Link>`). Shows a spinner
 * while that specific link's navigation is pending.
 *
 *   <Link href="/users/123">
 *     View user <LinkPending />
 *   </Link>
 *
 * `useLinkStatus()` returns `{ pending }`; if used outside a Link it stays
 * `false`, making this a safe no-op rather than a crash.
 */
export function LinkPending({
  size = 14,
  className,
  label = "Loading…",
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <Spinner
      size={size}
      label={label}
      className={cn("ml-1.5 inline-block align-middle", className)}
    />
  );
}

/**
 * Wraps arbitrary link children and dims + de-emphasizes them while the link's
 * navigation is pending, appending a trailing spinner. Useful for sidebar /
 * nav items where you want the whole row to read as "loading".
 *
 *   <Link href="/analytics">
 *     <LinkPendingShell>
 *       <BarChart /> Analytics
 *     </LinkPendingShell>
 *   </Link>
 */
export function LinkPendingShell({
  children,
  className,
  spinner = true,
  spinnerSize = 14,
}: {
  children: React.ReactNode;
  className?: string;
  spinner?: boolean;
  spinnerSize?: number;
}) {
  const { pending } = useLinkStatus();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 motion-safe:transition-opacity motion-safe:duration-150",
        pending && "opacity-60",
        className,
      )}
      aria-busy={pending || undefined}
    >
      {children}
      {spinner && pending ? <Spinner size={spinnerSize} /> : null}
    </span>
  );
}
