"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Layers } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { movePackCardsToSet } from "./actions";
import { invalidatePackDetailCache } from "./pack-detail-cache";

export function ChangePackSet({
  packId,
  cardCount,
  sets,
  onMoved,
}: {
  packId: string;
  cardCount: number;
  sets: { id: string; name: string }[];
  onMoved?: () => void;
}) {
  const router = useRouter();
  const [setId, setSetId] = useState("");
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const selected = sets.find((s) => s.id === setId);

  function confirmMove() {
    startTransition(async () => {
      try {
        const res = await movePackCardsToSet(packId, setId);
        invalidatePackDetailCache(packId);
        toast.success(
          `Moved ${res.count} card${res.count === 1 ? "" : "s"} to ${res.setName}`,
        );
        setOpen(false);
        onMoved?.();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to move cards");
      }
    });
  }

  return (
    <div className="space-y-4">
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <Layers className="size-4" />
        Card Set / Pool
      </h3>
      <p className="text-xs text-muted-foreground">
        Reassigns all {cardCount} card{cardCount === 1 ? "" : "s"} in this pack to
        the chosen set. A pack&apos;s pool tab (Pokemon / One Piece / Rewards /
        Meme) is derived from the sets of its cards. Because cards are shared,
        this also moves them in every other pack that contains them and in the
        /cards catalog.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label>Target set</Label>
          <Select value={setId} onValueChange={(v) => v && setSetId(v)}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Choose a set…" />
            </SelectTrigger>
            <SelectContent>
              {sets.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!setId || cardCount === 0}
          onClick={() => setOpen(true)}
        >
          Move {cardCount} card{cardCount === 1 ? "" : "s"}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move cards to {selected?.name ?? "set"}?</DialogTitle>
            <DialogDescription>
              This reassigns all {cardCount} card
              {cardCount === 1 ? "" : "s"} in this pack to{" "}
              <strong>{selected?.name}</strong> in the live game database. Because
              cards are shared across packs, those cards also move in every other
              pack that contains them and in the /cards catalog. This cannot be
              undone automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button onClick={confirmMove} disabled={isPending || !setId}>
              {isPending ? "Moving…" : "Move cards"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
