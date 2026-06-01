"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/** Compact human byte size for the success toast (e.g. "1.2 MB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
 * Download is done via `fetch()` → `Blob` → object-URL anchor (not a bare
 * `window.location` navigation) specifically so we get a real completion
 * signal: a `toast.loading` is shown while the CSV is being built/streamed
 * and is replaced by a success or error toast once the blob arrives (or the
 * request fails). The request can take a while on heavy lifetime exports —
 * the live toast tells the admin it's still working instead of looking dead.
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

  async function handleClick() {
    if (preparing) return;

    const query = new URLSearchParams({ page });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, value);
    }
    const href = `/insights/export?${query.toString()}`;

    setPreparing(true);
    // Live status toast that stays up until the CSV is ready (or fails).
    const toastId = toast.loading("Preparing export… this can take a moment for large windows.");

    let objectUrl: string | null = null;
    try {
      const res = await fetch(href);
      if (!res.ok) {
        throw new Error(`Export failed (${res.status})`);
      }
      const blob = await res.blob();

      // Filename: prefer the server's Content-Disposition, else derive one.
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = /filename="?([^"]+)"?/i.exec(disposition);
      const filename = match?.[1] ?? `insights-${page}.csv`;

      objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();

      const rows = blob.size;
      toast.success(
        `Export ready — ${filename} (${formatBytes(rows)})`,
        { id: toastId },
      );
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Export failed",
        { id: toastId },
      );
    } finally {
      // Revoke after a tick so the download has grabbed the blob.
      if (objectUrl) {
        const url = objectUrl;
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      setPreparing(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void handleClick()}
      disabled={preparing}
      aria-busy={preparing}
    >
      <Download className="size-3.5" />
      {preparing ? "Exporting…" : label}
    </Button>
  );
}
