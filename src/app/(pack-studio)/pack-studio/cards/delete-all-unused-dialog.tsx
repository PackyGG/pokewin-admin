"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Loader2,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatNumber } from "@/lib/utils/format";
import {
  loadCardIdsForUnusedFilter,
  deletePackStudioCards,
  type CardBlockedReason,
} from "./_actions";
import type { CardsFilter } from "./cards-explorer";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Pack Studio · Card Editor — "Delete all unused" flow
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Two-phase, admin-only:
 *
 *   1. On OPEN → `loadCardIdsForUnusedFilter` recomputes, over the ACTIVE
 *      filter (capped at 500), the safely-deletable id set + the blocked cards
 *      with reason codes. Nothing is mutated; the operator sees exactly what
 *      will and won't be removed BEFORE confirming.
 *   2. On CONFIRM → `deletePackStudioCards` deletes only the unreferenced ids.
 *      That action is admin-only + writes a `cards_bulk_deleted` audit event
 *      server-side; it re-runs the same reference check so a card that became
 *      referenced between preview and confirm is still skipped (never orphaned).
 *
 * The destructive button is disabled until the preview resolves with at least
 * one deletable card. House style: rose AlertDialog affordance (catalog
 * hygiene is money-neutral, but the action is irreversible).
 */

const BLOCKED_REASON_LABEL: Record<CardBlockedReason, string> = {
  in_packs: "in a pack",
  in_inventory: "held in inventory",
  in_upgrader_output: "in the upgrader output pool",
  in_upgrader_target: "an upgrader target card",
  in_provably_fair: "referenced by provably-fair records",
};

type Preview =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      deletable: string[];
      blocked: { reason: CardBlockedReason; count: number }[];
      scanned: number;
    };

export function DeleteUnusedDialog({
  open,
  onOpenChange,
  filter,
  matchingTotal,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filter: CardsFilter;
  /** Total cards matching the filter (for the "capped at 500" hint). */
  matchingTotal: number;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = React.useState<Preview>({ kind: "loading" });
  const [pending, startTransition] = React.useTransition();

  // Recompute the preview every time the dialog opens (or the filter changes
  // while open) so the operator always confirms against a fresh safe set.
  const filterKey = React.useMemo(
    () =>
      [
        filter.search ?? "",
        filter.rarity ?? "",
        filter.setId ?? "",
        filter.minPrice ?? "",
        filter.maxPrice ?? "",
      ].join("|"),
    [filter],
  );

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview({ kind: "loading" });
    loadCardIdsForUnusedFilter(filter, 500)
      .then((res) => {
        if (cancelled) return;
        const counts = new Map<CardBlockedReason, number>();
        for (const b of res.blocked) {
          counts.set(b.reason, (counts.get(b.reason) ?? 0) + 1);
        }
        setPreview({
          kind: "ready",
          deletable: res.deletable,
          blocked: Array.from(counts.entries()).map(([reason, count]) => ({
            reason,
            count,
          })),
          scanned: res.scanned,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setPreview({
          kind: "error",
          message:
            e instanceof Error
              ? e.message
              : "Couldn't compute the safely-deletable set.",
        });
      });
    return () => {
      cancelled = true;
    };
    // filterKey captures every field of `filter` that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filterKey]);

  const deletableCount =
    preview.kind === "ready" ? preview.deletable.length : 0;

  function handleDelete() {
    if (preview.kind !== "ready" || preview.deletable.length === 0) return;
    const ids = preview.deletable;
    startTransition(async () => {
      try {
        const result = await deletePackStudioCards({ ids });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        const { deletedCount, blocked } = result.data;
        if (blocked.length === 0) {
          toast.success(
            `Deleted ${formatNumber(deletedCount)} unused card${deletedCount === 1 ? "" : "s"}`,
          );
        } else {
          toast.success(
            `Deleted ${formatNumber(deletedCount)} unused card${deletedCount === 1 ? "" : "s"} · skipped ${formatNumber(blocked.length)} that became referenced`,
          );
        }
        onOpenChange(false);
        onDeleted();
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to delete unused cards",
        );
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-rose-500/10 text-rose-500">
            <AlertTriangle />
          </AlertDialogMedia>
          <AlertDialogTitle>Delete all unused cards</AlertDialogTitle>
          <AlertDialogDescription>
            Permanently removes every card in the current filter that is{" "}
            <strong>not</strong> referenced anywhere — not in a pack, not held
            in inventory, not used by the upgrader, and not referenced by a
            provably-fair record. This cannot be undone. The scan is capped at
            the first 500 matching cards.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* ── Preview body ─────────────────────────────────────────────── */}
        <div className="rounded-lg border bg-muted/20 p-3 text-sm">
          {preview.kind === "loading" && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Computing the safely-deletable set…
            </div>
          )}

          {preview.kind === "error" && (
            <div className="text-rose-500">{preview.message}</div>
          )}

          {preview.kind === "ready" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-emerald-500" />
                <span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {formatNumber(preview.deletable.length)}
                  </span>{" "}
                  card{preview.deletable.length === 1 ? "" : "s"} safe to delete
                  {preview.scanned > 0 ? (
                    <span className="text-muted-foreground">
                      {" "}
                      of {formatNumber(preview.scanned)} scanned
                    </span>
                  ) : null}
                </span>
              </div>

              {preview.blocked.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <ShieldAlert className="size-4" />
                    <span>Skipped (still referenced):</span>
                  </div>
                  <ul className="ml-6 list-disc space-y-0.5 text-muted-foreground">
                    {preview.blocked.map((b) => (
                      <li key={b.reason}>
                        <span className="font-medium tabular-nums text-foreground">
                          {formatNumber(b.count)}
                        </span>{" "}
                        {BLOCKED_REASON_LABEL[b.reason]}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {matchingTotal > preview.scanned && (
                <p className="text-xs text-muted-foreground/80">
                  {formatNumber(matchingTotal)} cards match this filter; only
                  the first {formatNumber(preview.scanned)} were scanned. Re-run
                  after deleting to clean up the rest.
                </p>
              )}

              {preview.deletable.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Nothing to delete — every matching card is still in use.
                </p>
              )}
            </div>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={
              pending || preview.kind !== "ready" || deletableCount === 0
            }
            className="bg-rose-500 hover:bg-rose-600 focus:ring-rose-500"
          >
            {pending
              ? "Deleting…"
              : `Delete ${formatNumber(deletableCount)} card${deletableCount === 1 ? "" : "s"}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
