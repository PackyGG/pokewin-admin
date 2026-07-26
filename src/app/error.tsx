"use client";

import * as React from "react";

/**
 * Root segment boundary for errors that happen outside a route group's own
 * boundary, including failures in a route-group layout. Keep this dependency
 * free so the fallback remains renderable when the normal component stack is
 * what failed.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    try {
      console.error("[root-error] route render failed:", error);
    } catch {
      // Logging must never be able to break the last usable route fallback.
    }
  }, [error]);

  return (
    <main
      role="alert"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
        background: "#0b0e15",
        color: "#e7e9ee",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <section
        style={{
          width: "100%",
          maxWidth: 480,
          padding: "1.5rem",
          border: "1px solid rgba(244,63,94,0.3)",
          borderRadius: 12,
          background: "rgba(244,63,94,0.06)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.125rem" }}>
          This page could not load
        </h1>
        <p style={{ margin: "0.75rem 0 1.25rem", color: "#b6b9c2" }}>
          The failure was contained. Retry the page or return to the dashboard.
          {error.digest ? (
            <span
              style={{
                display: "block",
                marginTop: 6,
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                fontSize: "0.75rem",
              }}
            >
              Digest {error.digest}
            </span>
          ) : null}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "0.5rem 0.875rem",
              border: 0,
              borderRadius: 8,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          <a
            href="/dashboard"
            style={{
              padding: "0.5rem 0.875rem",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 8,
              color: "inherit",
              textDecoration: "none",
            }}
          >
            Back to dashboard
          </a>
        </div>
      </section>
    </main>
  );
}
