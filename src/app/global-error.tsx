"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * Last-resort error boundary. `global-error.tsx` catches errors thrown
 * inside the ROOT `app/layout.tsx` itself — situations where even the
 * `(admin)/error.tsx` boundary can't render because the layout above
 * it never mounted (broken provider, broken fetch in the layout, broken
 * font import, etc.). For those cases Next.js replaces the entire
 * document with whatever this file renders, so it must define `<html>`
 * and `<body>` itself.
 *
 * Behavior is intentionally minimal (no shadcn imports — those depend
 * on the global stylesheet which may have failed to load by the time
 * we get here). Plain inline styles only, so the page CAN render even
 * when the rest of the app is in a broken state.
 *
 * Note: this file ONLY runs in production builds. In dev, Next's red
 * error overlay takes precedence so the developer sees the full stack.
 *
 * ─── Error-boundary hierarchy in this app ───────────────────────────
 *
 * Errors propagate UP the route tree until they hit an `error.tsx` or
 * `global-error.tsx` boundary. Three levels are in use here:
 *
 *   1. `app/global-error.tsx` (this file) — catches throws from the
 *      ROOT layout itself. No HTML / chrome from the app shell is
 *      available, so it owns its own <html>+<body>.
 *
 *   2. `app/(admin)/error.tsx` — umbrella for the entire admin
 *      route group. Catches anything thrown inside the admin shell
 *      (page render, server query, mutation that throws across the
 *      RSC boundary). The shell layout — sidebar, header, docked
 *      widgets — still renders ABOVE the fallback.
 *
 *   3. Per-segment `app/(admin)/<segment>/error.tsx` — tighter scope
 *      with segment-specific copy. Existing today:
 *      analytics, battles, creators, dashboard, employees, marketing,
 *      packs, rewards, salaries, transactions, users (+ /users/[id]),
 *      withdrawals. The umbrella in (2) is the fallback for any
 *      segment that doesn't define its own.
 *
 *   4. (Optional) Suspense fallback inside a page — `<Suspense
 *      fallback={...}>` shows a skeleton while a streamed RSC chunk
 *      is in flight. Throws inside the suspending Server Component
 *      propagate to the nearest error.tsx (NOT the Suspense fallback)
 *      so the boundary semantics above still apply.
 *
 * ─── Hooks rules — non-negotiable in every Client Component ─────────
 *
 *   - `useState`, `useMemo`, `useEffect`, `useCallback`, `useRef`,
 *     `useContext`, `useTransition`, `useId`, `useRouter`,
 *     `usePathname`, `useSearchParams`, etc. must ALL be called in
 *     the same ORDER on every render.
 *   - NEVER call a hook inside an `if`, a loop, a ternary, after an
 *     early `return`, or after a `throw`. Move the early return BELOW
 *     all hook calls.
 *   - When a hook is conditional in semantics ("only run when X is
 *     truthy"), still CALL the hook unconditionally — gate the work
 *     INSIDE the hook (e.g. `useEffect(() => { if (!X) return; ... })`).
 *   - Custom hooks (anything starting with `use`) inherit these rules
 *     — they can return early but they must not skip a downstream
 *     hook between renders.
 *   - Hook-rule violations crash with React error #310 ("Rendered
 *     fewer/more hooks than expected"). In prod the digest is the
 *     only client-visible signal — server logs (Vercel function logs)
 *     have the full stack.
 *
 * ─── Server Actions across the RSC boundary ─────────────────────────
 *
 *   - Server Actions should return discriminated unions
 *     (`{ success: true; data } | { success: false; error }`),
 *     NOT throw, so client callers can render an inline error state
 *     instead of triggering an error boundary.
 *   - Throwing from a Server Action is reserved for unexpected /
 *     unrecoverable failures — the error.tsx boundary catches them,
 *     but the UX is worse than a typed-error return.
 *   - `redirect()` and `notFound()` are NOT errors — they signal
 *     navigation and short-circuit cleanly. Don't wrap them in
 *     try/catch.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global-error] root layout threw:", error);
    // Report to Sentry (no-op when dormant). This is where root-layout React
    // crashes (incl. transient hook-order #310) become visible with a digest.
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0b0e15",
          color: "#e7e9ee",
          fontFamily:
            "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          padding: "2rem",
        }}
      >
        <div
          style={{
            maxWidth: 480,
            width: "100%",
            border: "1px solid rgba(244,63,94,0.3)",
            backgroundColor: "rgba(244,63,94,0.06)",
            borderRadius: 12,
            padding: "1.5rem",
          }}
        >
          <h1
            style={{
              margin: 0,
              marginBottom: "0.75rem",
              fontSize: "1.125rem",
              fontWeight: 600,
            }}
          >
            The admin app failed to load
          </h1>
          <p
            style={{
              margin: 0,
              marginBottom: "1rem",
              fontSize: "0.875rem",
              color: "#b6b9c2",
              lineHeight: 1.5,
            }}
          >
            {/* Never surface the raw error.message in production — it can
                leak internal detail (query text, table names, stack hints).
                Show a generic sentence + the digest only, matching every
                other error boundary's no-raw-message policy. In dev the raw
                message is kept to aid debugging (this file only renders in
                prod builds, but the guard keeps the policy explicit). */}
            {process.env.NODE_ENV !== "production" && error.message
              ? error.message
              : "An unexpected error happened while rendering the root layout."}
            {error.digest && (
              <span
                style={{
                  marginLeft: 6,
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  fontSize: "0.75rem",
                }}
              >
                (digest {error.digest})
              </span>
            )}
          </p>
          <p
            style={{
              margin: 0,
              marginBottom: "1.25rem",
              fontSize: "0.75rem",
              color: "#9095a3",
              lineHeight: 1.5,
            }}
          >
            This is the last-resort error page (the root layout itself
            threw, so the normal admin shell isn&apos;t rendering).
            Server logs (Vercel Functions) have the stack — search the
            digest above.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button
              type="button"
              onClick={reset}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "0.5rem 0.875rem",
                fontSize: "0.875rem",
                fontWeight: 600,
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.9)",
                backgroundColor: "#e7e9ee",
                color: "#0b0e15",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            {/* Full document reload back to the dashboard. A plain anchor
                (not next/link) — the router/shell isn't mounted here, so we
                fall back to a hard navigation, which also gives the broken
                root layout a clean re-mount. */}
            <a
              href="/dashboard"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "0.5rem 0.875rem",
                fontSize: "0.875rem",
                fontWeight: 500,
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.18)",
                backgroundColor: "transparent",
                color: "inherit",
                textDecoration: "none",
                cursor: "pointer",
              }}
            >
              Back to dashboard
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
