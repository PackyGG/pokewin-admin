"use client";

import { reportWebappError } from "@/lib/errors/report-webapp-error";

import { useEffect } from "react";

import { HubErrorPage } from "../_components/hub-error-page";

/**
 * Segment-level error boundary for `/creator-hub/socials-review`.
 *
 * Renders INSIDE the hub shell via the shared `HubErrorPage`, so an uncaught
 * throw (auth lookup, backend API, audit write surfacing through a render)
 * no longer white-screens into `global-error.tsx` — the reviewer keeps the
 * sidebar and gets a retry that re-renders just this segment.
 *
 * SECURITY: `error.message` is intentionally NOT rendered (HubErrorPage never
 * echoes it) — only the opaque digest for log correlation.
 */
export default function SocialsReviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportWebappError({
      source: "react-boundary",
      boundary: "(creator-hub)/creator-hub/socials-review",
      error,
      digest: error.digest,
    });
    console.error("[creator-hub/socials-review] error boundary caught:", error);
  }, [error]);

  return (
    <HubErrorPage
      title="Couldn't load Socials Review"
      detail="The social-submission queue failed to load before the page could render. The error was logged — try again, or head back to the hub dashboard."
      digest={error.digest}
      reset={reset}
    />
  );
}
