"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createRaffle, type SearchItem } from "./actions";
import { PrizePicker } from "./prize-picker";

type PrizeEntry = {
  _key: string;
  type: "pack" | "card";
  id: string;
  quantity: number;
  name?: string;
  imageUrl?: string | null;
  priceUsd?: number;
};

export function CreateRaffleButton() {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [minPoints, setMinPoints] = useState("");
  const [maxPoints, setMaxPoints] = useState("");
  const [prizes, setPrizes] = useState<PrizeEntry[]>([{ _key: crypto.randomUUID(), type: "pack", id: "", quantity: 1 }]);

  function addPrize() {
    setPrizes((prev) => [...prev, { _key: crypto.randomUUID(), type: "pack", id: "", quantity: 1 }]);
  }

  function removePrize(index: number) {
    setPrizes((prev) => prev.filter((_, i) => i !== index));
  }

  function updatePrizeType(index: number, type: "pack" | "card") {
    setPrizes((prev) =>
      prev.map((p, i) =>
        i === index ? { _key: p._key, type, id: "", quantity: p.quantity } : p,
      ),
    );
  }

  function updatePrizeItem(index: number, item: SearchItem) {
    setPrizes((prev) =>
      prev.map((p, i) =>
        i === index
          ? { ...p, id: item.id, name: item.name, imageUrl: item.imageUrl, priceUsd: item.priceUsd }
          : p,
      ),
    );
  }

  function updatePrizeQuantity(index: number, quantity: number) {
    setPrizes((prev) =>
      prev.map((p, i) => (i === index ? { ...p, quantity } : p)),
    );
  }

  function resetForm() {
    setName("");
    setDescription("");
    setStartsAt("");
    setEndsAt("");
    setMinPoints("");
    setMaxPoints("");
    setPrizes([{ _key: crypto.randomUUID(), type: "pack", id: "", quantity: 1 }]);
  }

  function handleSubmit() {
    if (!name.trim()) {
      toast.error("Please enter a name");
      return;
    }
    if (!startsAt || !endsAt) {
      toast.error("Please set start and end dates");
      return;
    }
    const validPrizes = prizes.filter((p) => p.id);
    if (validPrizes.length === 0) {
      toast.error("Please add at least one prize");
      return;
    }
    for (const p of validPrizes) {
      if (p.quantity < 1) {
        toast.error("Prize quantity must be at least 1");
        return;
      }
    }

    startTransition(async () => {
      try {
        const result = await createRaffle({
          name: name.trim(),
          description: description.trim() || undefined,
          startsAt,
          endsAt,
          minPointsPerEntry: minPoints ? parseInt(minPoints, 10) : undefined,
          maxPointsPerEntry: maxPoints ? parseInt(maxPoints, 10) : undefined,
          prizes: validPrizes.map((p) => ({ type: p.type, id: p.id, quantity: p.quantity })),
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Raffle created");
        setOpen(false);
        resetForm();
        router.refresh();
      } catch (e) {
        // Only unexpected (non-raffle) errors land here — e.g. network failure
        // before the action reached the server. The action itself returns
        // { success: false, error } for all expected failure modes.
        toast.error(e instanceof Error ? e.message : "Failed to create raffle");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        Create Raffle
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Raffle</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly Raffle" />
          </div>
          <div className="space-y-2">
            <Label>Description (optional)</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Enter to win..." />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Starts At</Label>
              <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Ends At</Label>
              <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Min Points per Entry (optional)</Label>
              <Input type="number" value={minPoints} onChange={(e) => setMinPoints(e.target.value)} placeholder="0" min={0} />
            </div>
            <div className="space-y-2">
              <Label>Max Points per Entry (optional)</Label>
              <Input type="number" value={maxPoints} onChange={(e) => setMaxPoints(e.target.value)} placeholder="No limit" min={0} />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Prizes</Label>
              <Button type="button" variant="outline" size="sm" onClick={addPrize}>
                <Plus className="mr-1 size-3" /> Add Prize
              </Button>
            </div>
            {prizes.map((prize, i) => (
              <div key={prize._key} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Prize #{i + 1}</span>
                  <div className="flex-1" />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() => removePrize(i)}
                    disabled={prizes.length === 1}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="space-y-1 sm:w-24">
                    <Label className="text-xs">Type</Label>
                    <Select value={prize.type} onValueChange={(v) => v && updatePrizeType(i, v as "pack" | "card")}>
                      <SelectTrigger className="h-9 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pack">Pack</SelectItem>
                        <SelectItem value="card">Card</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">{prize.type === "pack" ? "Pack" : "Card"}</Label>
                    <PrizePicker
                      type={prize.type}
                      value={prize.id ? { id: prize.id, name: prize.name, imageUrl: prize.imageUrl, priceUsd: prize.priceUsd } : null}
                      onSelect={(item) => updatePrizeItem(i, item)}
                    />
                  </div>
                  <div className="space-y-1 sm:w-20">
                    <Label className="text-xs">Qty</Label>
                    <Input
                      type="number"
                      value={prize.quantity}
                      onChange={(e) => updatePrizeQuantity(i, parseInt(e.target.value, 10) || 1)}
                      onFocus={(e) => e.target.select()}
                      min={1}
                      className="h-9"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={isPending} className="w-full sm:w-auto">
            {isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
