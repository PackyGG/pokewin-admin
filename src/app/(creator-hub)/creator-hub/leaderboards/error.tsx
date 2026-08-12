"use client";

import { reportWebappError } from "@/lib/errors/report-webapp-error";

import { useEffect } from "react";

import { HubErrorPage } from "../_components/hub-error-page";

/**
 * Segment-level error boundary for `/creator-hub/leaderboards`.
 *
 * Renders INSIDE the hub shell (the layout above survives), so an uncaught
 * throw from the ranked boards or a leaderboard query no longer white-screens
 * into `global-error.tsx`. Per-leg failures are handled by the in-page
 * degraded states; this boundary is the LAST line for anything that escapes
 * them. Body is the shared `HubErrorPage` — never echoes `error.message`
 * (the digest is the safe correlation handle).
 */
export default function CreatorHubLeaderboardsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportWebappError({
      source: "react-boundary",
      boundary: "(creator-hub)/creator-hub/leaderboards",
      error,
      digest: error.digest,
    });
    console.error("[creator-hub/leaderboards] error boundary caught:", error);
  }, [error]);

  return (
    <HubErrorPage
      title="Couldn't load Live Leaderboards"
      detail="A leaderboard query failed before the page could render — the ranked boards, standings, or the backend API. The error was logged; try again, or head back to the hub dashboard."
      digest={error.digest}
      reset={reset}
    />
  );
}
