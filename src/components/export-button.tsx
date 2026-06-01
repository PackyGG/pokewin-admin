"use client";

import * as React from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  downloadCsv,
  sectionsToCsv,
  totalRowCount,
  type ExportSection,
} from "@/lib/utils/export-csv";

/**
 * Shared "Export data" button for the Insights pages.
 *
 * Sized to sit in a PageHero action slot next to the period / tab
 * switchers. On click it calls the server `action` passed in from the
 * page (server actions are passable to client components as props in
 * Next 15), serializes the returned `ExportSection[]` to CSV, and
 * triggers a browser download.
 *
 * This component imports ONLY client-safe modules (the csv util +
 * lucide + sonner + the shadcn Button) so it never drags a server-only
 * graph into the client bundle. The per-page export query logic lives
 * server-side inside `action`.
 *
 * `useTransition` drives the spinner so the button stays responsive and
 * disables itself while the export query runs. Errors surface as a
 * toast (matching the codebase's sonner error pattern) instead of
 * throwing into the client.
 */
export function ExportButton({
  action,
  filename,
  label = "Export data",
}: {
  /**
   * Server action that gathers every section for the active
   * period / tab / filters and returns them. Passed from the page so
   * its server-only imports never reach the client bundle.
   */
  action: () => Promise<ExportSection[]>;
  /** Download filename, e.g. `insights-deposit-bonus-30d.csv`. */
  filename: string;
  /** Button text. Defaults to "Export data". */
  label?: string;
}) {
  const [pending, startTransition] = React.useTransition();

  function handleClick() {
    startTransition(async () => {
      try {
        const sections = await action();
        const rowCount = totalRowCount(sections);
        if (rowCount === 0) {
          toast.info("No data to export for this view.");
          return;
        }
        const csv = sectionsToCsv(sections);
        downloadCsv(filename, csv);
        toast.success(
          `Exported ${rowCount.toLocaleString("en-US")} ${
            rowCount === 1 ? "row" : "rows"
          }.`,
        );
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Export failed.",
        );
      }
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Download className="size-3.5" />
      )}
      {label}
    </Button>
  );
}
