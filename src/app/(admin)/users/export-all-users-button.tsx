"use client";

import * as React from "react";
import { toast } from "sonner";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportAllUsersCsv } from "./actions";

/**
 * motha-only one-click "Export all users" button. Calls the
 * `exportAllUsersCsv` Server Action (which independently re-verifies the
 * caller is motha — this button only renders for motha as defense in
 * depth, never as the security boundary), then turns the returned CSV
 * string into a Blob and triggers a browser download.
 *
 * Distinct from the filtered `ExportUsersButton` dialog next to it: this
 * is the raw 3-column (email, username, deposit) dump of every user.
 */
export function ExportAllUsersButton() {
  const [downloading, setDownloading] = React.useState(false);

  async function handleExport() {
    setDownloading(true);
    try {
      const { csv, filename } = await exportAllUsersCsv();

      // Synthesize an anchor click on an object URL — the standard
      // "string → file download" pattern (browsers expose no direct
      // save API). UTF-8 BOM prepended so Excel reads non-ASCII
      // emails/usernames correctly.
      const blob = new Blob(["﻿", csv], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      toast.success("Export downloaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleExport}
      disabled={downloading}
    >
      {downloading ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Download className="size-4" />
      )}
      {downloading ? "Exporting…" : "Export all"}
    </Button>
  );
}
