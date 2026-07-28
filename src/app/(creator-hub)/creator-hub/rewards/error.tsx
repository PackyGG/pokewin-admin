"use client";

import { useEffect } from "react";

import { HubErrorPage } from "../_components/hub-error-page";

/**
 * Segment-level error boundary for `/creator-hub/rewards`.
 *
 * Renders INSIDE the hub shell (the layout above survives), so an uncaught
 * throw from the programs/claims reads or the shared reward content no longer
 * white-screens into `global-error.tsx`. Per-read failures are handled by the
 * in-page degraded notices; this boundary is the LAST line for anything that
 * escapes them. Body is the shared `HubErrorPage` — never echoes
 * `error.message` (the digest is the safe correlation handle).
 */
export default function CreatorHubRewardsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[creator-hub/rewards] error boundary caught:", error);
  }, [error]);

  return (
    <HubErrorPage
      title="Couldn't load Creator Rewards"
      detail="Something failed before the reward programs and claim queue could render. The error was logged; try again, or head back to the hub dashboard."
      digest={error.digest}
      reset={reset}
    />
  );
}
