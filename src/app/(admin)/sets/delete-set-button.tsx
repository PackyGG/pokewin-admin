"use client";

import * as React from "react";
import { useTransition } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatNumber } from "@/lib/utils/format";

import { deleteSet } from "./actions";

/**
 * Confirm-then-delete button for a single set.
 *
 * Important: deleting a set does NOT delete the cards inside it. The
 * server action nullifies `cards.set_id` first, then drops the set
 * row. Cards remain in the catalog as orphan rows (no set assignment)
 * and can be bulk-reassigned to a different set via /cards.
 *
 * The action returns a `ServerActionResult` — we branch on
 * `result.success` and surface `result.error` verbatim on failure.
 */
export function DeleteSetButton({
  id,
  name,
  cardCount,
}: {
  id: string;
  name: string;
  cardCount: number;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteSet(id);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      const { cardsOrphaned } = result.data;
      toast.success(
        cardsOrphaned === 0
          ? "Set deleted"
          : `Set deleted · ${formatNumber(cardsOrphaned)} card${cardsOrphaned === 1 ? "" : "s"} orphaned`,
      );
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        size="xs"
        variant="ghost"
        className="text-muted-foreground hover:text-rose-500"
        onClick={() => setOpen(true)}
        aria-label={`Delete ${name}`}
      >
        <Trash2 className="size-3.5" />
        Delete
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete &ldquo;{name}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This removes the set itself. The {formatNumber(cardCount)} card
            {cardCount === 1 ? "" : "s"} in this set will become orphan card
            {cardCount === 1 ? "" : "s"} (no set assignment) — they&apos;re
            NOT deleted and you can bulk-assign them to a different set on
            /cards.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={pending}
            className="bg-rose-500 hover:bg-rose-600 focus:ring-rose-500"
          >
            {pending ? "Deleting…" : "Delete set"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
