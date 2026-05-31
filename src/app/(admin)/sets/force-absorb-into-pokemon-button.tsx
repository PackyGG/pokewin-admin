"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Combine, Loader2 } from "lucide-react";
import { toast } from "sonner";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { formatNumber } from "@/lib/utils/format";
import { forceAbsorbIntoPokemon } from "./actions";

/**
 * Second-stage bulk absorb. The initial seed (`SeedInitialSetsButton`)
 * only handled cards with `set_id IS NULL`; this button sweeps every
 * card NOT in the OnePiece set into Pokemon, catching the ~50k cards
 * that still carry legacy TCGPlayer-import `set_id` values.
 *
 * Wrapped in an AlertDialog (not a plain Dialog) because the action is
 * destructive — it deletes the now-empty legacy sets afterwards. The
 * confirm text spells out exactly which rows are touched and which are
 * left alone.
 */
export function ForceAbsorbIntoPokemonButton() {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleConfirm() {
    startTransition(async () => {
      try {
        const result = await forceAbsorbIntoPokemon();
        toast.success(
          `Moved ${formatNumber(result.cardsMoved)} cards into Pokemon · deleted ${formatNumber(result.legacySetsDeleted)} empty legacy sets`,
        );
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to force-absorb cards",
        );
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" />}>
        <Combine className="size-4" />
        Force-absorb into Pokemon
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Force-absorb all cards into Pokemon?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Moves every card NOT in the OnePiece set into the Pokemon set.
            This catches the ~50k cards that the initial seed missed (they
            had legacy <code className="font-mono text-xs">set_id</code>{" "}
            values). OnePiece cards are untouched. Idempotent — running it
            again does nothing. Optionally deletes empty legacy sets
            afterward.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Absorbing...
              </>
            ) : (
              <>
                <Combine className="size-4" />
                Run absorb
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
