"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
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
import { deleteCards } from "./actions";

/**
 * Admin-only bulk-delete confirmation for the /cards selection toolbar.
 *
 * Controlled (open state owned by `CardsExplorer`, same as `MoveToSetDialog`)
 * so it shares the toolbar's selection. Destructive: it spells out the count
 * and uses the house rose `AlertDialog` affordance (mirrors
 * `/sets` `DeleteSetButton`).
 *
 * The server action (`deleteCards`) is the real gate — it calls
 * `requireAdmin()` and refuses any card that is still in a pack or held in a
 * user's inventory, returning those as `blocked`. We surface the outcome
 * precisely: full success, a partial ("deleted N, skipped M") message, or the
 * server's verbatim block reason when nothing was deletable.
 */
export function DeleteCardsDialog({
  open,
  onOpenChange,
  selectedCardIds,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCardIds: string[];
  onDeleted: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const count = selectedCardIds.length;

  function handleDelete() {
    startTransition(async () => {
      try {
        const result = await deleteCards({ ids: selectedCardIds });
        if (!result.success) {
          toast.error(result.error);
          return;
        }

        const { deletedCount, blocked } = result.data;
        if (blocked.length === 0) {
          toast.success(
            `Deleted ${formatNumber(deletedCount)} card${deletedCount === 1 ? "" : "s"}`,
          );
        } else {
          // Partial: some were deleted, some were skipped because they're
          // still referenced. Tell the operator exactly how many and why.
          toast.success(
            `Deleted ${formatNumber(deletedCount)} card${deletedCount === 1 ? "" : "s"} · skipped ${formatNumber(blocked.length)} still in packs or user inventory`,
          );
        }

        onOpenChange(false);
        // Only the deleted rows left the catalog; clearing the whole
        // selection is the simplest correct state (the refresh re-fetches
        // the slice and any still-blocked cards can be re-selected).
        onDeleted();
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to delete cards",
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
          <AlertDialogTitle>
            Delete {formatNumber(count)} card{count === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the selected card
            {count === 1 ? "" : "s"} from the catalog. This action cannot be
            undone. Cards that are still used in a pack, or currently held in
            any user&apos;s inventory, are skipped automatically and stay in
            the catalog.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={pending || count === 0}
            className="bg-rose-500 hover:bg-rose-600 focus:ring-rose-500"
          >
            {pending
              ? "Deleting…"
              : `Delete ${formatNumber(count)} card${count === 1 ? "" : "s"}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
