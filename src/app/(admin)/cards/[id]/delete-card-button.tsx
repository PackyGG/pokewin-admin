"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { deleteCard } from "../actions";

export function DeleteCardButton({
  cardId,
  cardName,
  packCount,
  packNames,
}: {
  cardId: string;
  cardName: string;
  packCount: number;
  packNames: string[];
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleDelete() {
    startTransition(async () => {
      try {
        await deleteCard(cardId);
        toast.success("Card deleted");
        router.push("/cards");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to delete card");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="destructive" />}>
        <Trash2 className="mr-1 size-3.5" />
        Delete
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Card</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <strong>{cardName}</strong>? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {packCount > 0 && (
          <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm">
            <p className="font-medium text-yellow-400">This card is used in {packCount} pack(s):</p>
            <ul className="mt-1 list-disc pl-5 text-yellow-400/80">
              {packNames.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            <p className="mt-2 text-yellow-400/80">You must remove it from these packs before deleting.</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isPending || packCount > 0}>
            {isPending ? "Deleting..." : "Delete Card"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
