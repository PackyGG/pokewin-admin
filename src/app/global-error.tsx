"use client";

import { useEffect } from "react";

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
            {error.message ||
              "An unexpected error happened while rendering the root layout."}
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
          <button
            type="button"
            onClick={reset}
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
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
