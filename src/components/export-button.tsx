"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/**
 * Shared "Export data" button for the Insights pages (and /ggr).
 *
 * Sized to sit in a PageHero action slot next to the period / tab
 * switchers. On click it navigates to the streaming CSV route handler
 * (`/insights/export?page=<page>&<params>`); the browser handles the
 * `Content-Disposition: attachment` response as a native file download,
 * leaving the current page untouched.
 *
 * Why a route handler and not a server action: the old version called a
 * server action that returned the whole `ExportSection[]` array to the
 * client to serialize into CSV here. On large datasets (lifetime period,
 * thousands of rows) that array exceeded the Next.js server-action
 * response body-size limit and the export broke. The route handler has
 * no such cap — it builds + serializes the CSV server-side and streams
 * it back as a file.
 *
 * This component imports ONLY client-safe modules (lucide + sonner + the
 * shadcn Button) so it never drags a server-only graph into the client
 * bundle. All export query logic lives server-side in the route handler.
 *
 * A native download gives no JS completion signal, so the button shows a
 * brief disabled state + a "Preparing download…" toast on click rather
 * than a success toast. The flag clears on a short timer (the navigation
 * itself doesn't fire an event we can hook).
 */
export function ExportButton({
  page,
  params = {},
  label = "Export data",
}: {
  /**
   * Export page key — selects the gatherer + permission gate in the
   * route handler's registry (e.g. `"deposit-bonus"`, `"games"`,
   * `"ggr"`).
   */
  page: string;
  /**
   * Active view params (period / tab lens / filters) forwarded to the
   * route so the export matches what the admin is currently looking at.
   * `undefined` values are dropped.
   */
  params?: Record<string, string | undefined>;
  /** Button text. Defaults to "Export data". */
  label?: string;
}) {
  const [preparing, setPreparing] = React.useState(false);

  function handleClick() {
    const query = new URLSearchParams({ page });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, value);
    }
    const href = `/insights/export?${query.toString()}`;

    setPreparing(true);
    toast.info("Preparing download…");
    // Navigating to an attachment response triggers the browser's file
    // download without unloading the current page. No completion event
    // is exposed, so re-enable on a short timer.
    window.location.href = href;
    window.setTimeout(() => setPreparing(false), 3000);
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={preparing}
      aria-busy={preparing}
    >
      <Download className="size-3.5" />
      {label}
    </Button>
  );
}
