"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
import { Spinner } from "@/components/ux";
import { createChallenge } from "./actions";
import { ItemPicker } from "./item-picker";
import type { SearchItem } from "./actions";

type Kind = "card" | "upgrader";
type PercentOp = "lte" | "gte" | "eq";

type PickedItem = { id: string; name?: string; imageUrl?: string | null; priceUsd?: number };

export function CreateChallengeButton() {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [kind, setKind] = useState<Kind>("card");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prizeAmount, setPrizeAmount] = useState("");
  const [maxClaims, setMaxClaims] = useState("1");
  const [pack, setPack] = useState<PickedItem | null>(null);
  const [card, setCard] = useState<PickedItem | null>(null);
  const [winPercentage, setWinPercentage] = useState("");
  const [percentOp, setPercentOp] = useState<PercentOp>("gte");

  function resetForm() {
    setKind("card");
    setName("");
    setDescription("");
    setPrizeAmount("");
    setMaxClaims("1");
    setPack(null);
    setCard(null);
    setWinPercentage("");
    setPercentOp("gte");
  }

  function handleKindChange(next: Kind) {
    setKind(next);
    // requirement fields differ between kinds — clear the ones that don't
    // apply so we never submit a stale pack_id on an upgrader challenge.
    setPack(null);
    setCard(null);
    setWinPercentage("");
  }

  function handleSubmit() {
    if (!name.trim()) {
      toast.error("Please enter a name");
      return;
    }
    const prize = parseFloat(prizeAmount);
    if (!Number.isFinite(prize) || prize <= 0) {
      toast.error("Enter a prize amount greater than 0");
      return;
    }
    const claims = parseInt(maxClaims, 10);
    if (!Number.isFinite(claims) || claims < 1) {
      toast.error("Max claims must be at least 1");
      return;
    }
    if (!card?.id) {
      toast.error("Please select a card");
      return;
    }
    if (kind === "card" && !pack?.id) {
      toast.error("Please select a pack");
      return;
    }
    if (kind === "upgrader") {
      const win = parseFloat(winPercentage);
      if (!Number.isFinite(win)) {
        toast.error("Enter a win percentage");
        return;
      }
    }

    startTransition(async () => {
      try {
        const result = await createChallenge({
          kind,
          name: name.trim(),
          description: description.trim() || undefined,
          prizeAmount: prize,
          maxClaims: claims,
          packId: kind === "card" ? pack?.id : undefined,
          cardId: card?.id,
          winPercentage:
            kind === "upgrader" ? parseFloat(winPercentage) : undefined,
          percentOp: kind === "upgrader" ? percentOp : undefined,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Challenge created");
        setOpen(false);
        resetForm();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to create challenge");
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetForm();
      }}
    >
      <DialogTrigger render={<Button />}>Create Challenge</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Challenge</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={(v) => v && handleKindChange(v as Kind)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="card">Card hit (pull a specific card from a pack)</SelectItem>
                <SelectItem value="upgrader">Upgrader hit (land a card at a win %)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pull the Charizard"
            />
          </div>
          <div className="space-y-2">
            <Label>Description (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Hit the target card to win a prize..."
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Prize Amount (USD)</Label>
              <Input
                type="number"
                value={prizeAmount}
                onChange={(e) => setPrizeAmount(e.target.value)}
                placeholder="10.00"
                min={0}
                step="0.01"
              />
            </div>
            <div className="space-y-2">
              <Label>Max Claims</Label>
              <Input
                type="number"
                value={maxClaims}
                onChange={(e) => setMaxClaims(e.target.value)}
                onFocus={(e) => e.target.select()}
                min={1}
                step={1}
              />
            </div>
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <Label className="text-xs font-medium text-muted-foreground">
              Requirement
            </Label>

            {kind === "card" && (
              <div className="space-y-2">
                <Label className="text-xs">Pack</Label>
                <ItemPicker
                  type="pack"
                  value={pack}
                  onSelect={(item: SearchItem) =>
                    setPack({
                      id: item.id,
                      name: item.name,
                      imageUrl: item.imageUrl,
                      priceUsd: item.priceUsd,
                    })
                  }
                />
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-xs">Card</Label>
              <ItemPicker
                type="card"
                value={card}
                onSelect={(item: SearchItem) =>
                  setCard({
                    id: item.id,
                    name: item.name,
                    imageUrl: item.imageUrl,
                    priceUsd: item.priceUsd,
                  })
                }
              />
            </div>

            {kind === "upgrader" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs">Operator</Label>
                  <Select
                    value={percentOp}
                    onValueChange={(v) => v && setPercentOp(v as PercentOp)}
                  >
                    <SelectTrigger className="h-9 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lte">≤ (at most)</SelectItem>
                      <SelectItem value="gte">≥ (at least)</SelectItem>
                      <SelectItem value="eq">= (exactly)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Win %</Label>
                  <Input
                    type="number"
                    value={winPercentage}
                    onChange={(e) => setWinPercentage(e.target.value)}
                    placeholder="50"
                    min={0}
                    max={100}
                    step="0.01"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={isPending} className="w-full sm:w-auto">
            {isPending && <Spinner size={15} className="text-current" />}
            {isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
