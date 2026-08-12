"use client";

import { reportWebappError } from "@/lib/errors/report-webapp-error";

import { useEffect } from "react";

import { HubErrorPage } from "../_components/hub-error-page";

/**
 * Segment-level error boundary for `/creator-hub/tips-sponsors` — renders
 * the shared HubErrorPage inside the hub shell (sidebar/layout survive).
 * Per-leg failures are handled by the in-page degraded states; this
 * boundary is the LAST line for anything that escapes them.
 *
 * SECURITY: HubErrorPage never echoes `error.message` — only the digest.
 */
export default function CreatorHubTipsSponsorsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportWebappError({
      source: "react-boundary",
      boundary: "(creator-hub)/creator-hub/tips-sponsors",
      error,
      digest: error.digest,
    });
    console.error("[creator-hub/tips-sponsors] error boundary caught:", error);
  }, [error]);

  return (
    <HubErrorPage
      title="Couldn't load Tips & Sponsors"
      detail="A tips-and-sponsors query failed before the page could render — the ledger window, the session counters, or the per-creator breakdown. Try again, or head back to the hub dashboard."
      digest={error.digest}
      reset={reset}
    />
  );
}
