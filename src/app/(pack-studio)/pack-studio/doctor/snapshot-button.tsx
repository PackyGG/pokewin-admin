"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { snapshotPackRisk } from "../_actions/snapshot";

/**
 * "Snapshot now" header action. Calls the {@link snapshotPackRisk} server action
 * (scores every active cash pack and upserts one `pack_risk_scores` row per pack
 * into the ADMIN DB — no MAIN writes), then refreshes the route so the freshly
 * persisted rows render. Success/error surface via `sonner` toasts.
 *
 * Two layered busy states: `isSaving` covers the awaited server action;
 * `isPending` covers the subsequent `router.refresh()` re-render. The button
 * stays disabled across both so a second click can't fire a duplicate snapshot
 * while the first is still settling.
 */
export function SnapshotButton() {
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const busy = isSaving || isPending;

  async function handleSnapshot() {
    setIsSaving(true);
    try {
      const result = await snapshotPackRisk();
      toast.success(
        result.count === 0
          ? "No active cash packs to score."
          : `Scored ${result.count} pack${result.count === 1 ? "" : "s"}.`,
      );
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to run the snapshot.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Button size="sm" onClick={handleSnapshot} disabled={busy}>
      <RefreshCw
        className={"size-4" + (busy ? " motion-safe:animate-spin" : "")}
        aria-hidden
      />
      {busy ? "Snapshotting…" : "Snapshot now"}
    </Button>
  );
}
