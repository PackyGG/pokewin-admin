"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { seedInitialSets } from "./actions";

/**
 * One-time backfill button. Visible only to admins. Triggers the
 * `seedInitialSets` server action which:
 *
 *  - upserts the "Pokemon" and "OnePiece" sets (idempotent by name), and
 *  - assigns every card with `set_id IS NULL` to the Pokemon set.
 *
 * Safe to click twice — duplicates are not created and only NULL-set
 * cards are moved.
 */
export function SeedInitialSetsButton() {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleConfirm() {
    startTransition(async () => {
      try {
        const result = await seedInitialSets();
        const parts: string[] = [];
        if (result.pokemonCreated) parts.push("Pokemon set created");
        else parts.push("Pokemon set already existed");
        if (result.onepieceCreated) parts.push("OnePiece set created");
        else parts.push("OnePiece set already existed");
        parts.push(
          result.cardsMoved === 0
            ? "no cards needed moving"
            : `${result.cardsMoved} card${result.cardsMoved === 1 ? "" : "s"} moved into Pokemon`,
        );
        toast.success(parts.join(" · "));
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to seed initial sets",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Sparkles className="size-4" />
        Seed initial sets
      </DialogTrigger>
      <DialogContent className="sm:max-w-md p-0">
        <div className="border-b bg-card px-5 py-4">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-amber-500/15">
                <Sparkles className="size-4 text-amber-500" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold leading-tight">
                  Seed initial sets
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  One-time backfill — safe to run more than once.
                </p>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="space-y-3 px-5 py-5 text-sm">
          <p>This will:</p>
          <ul className="ml-1 list-disc space-y-1.5 pl-4 text-muted-foreground">
            <li>
              Create the{" "}
              <span className="text-foreground font-medium">Pokemon</span> set
              if it doesn&apos;t exist yet.
            </li>
            <li>
              Create the{" "}
              <span className="text-foreground font-medium">OnePiece</span> set
              if it doesn&apos;t exist yet (kept empty).
            </li>
            <li>
              Move every card that currently has{" "}
              <span className="text-foreground font-medium">no set</span>{" "}
              assigned into the Pokemon set.
            </li>
          </ul>
          <p className="text-[12px] text-muted-foreground">
            Cards that already belong to a set are not touched. Running this
            again is harmless — no duplicates, no double-moves.
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Seeding...
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                Run seed
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
