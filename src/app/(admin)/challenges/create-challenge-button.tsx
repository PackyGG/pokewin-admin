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
  const [minBetUsd, setMinBetUsd] = useState("");
  const [minMultiplier, setMinMultiplier] = useState("");

  function resetForm() {
    setKind("card");
    setName("");
    setDescription("");
    setPrizeAmount("");
    setMaxClaims("1");
    setPack(null);
    setCard(null);
    setMinBetUsd("");
    setMinMultiplier("");
  }

  function handleKindChange(next: Kind) {
    setKind(next);
    // requirement fields differ between kinds — clear the ones that don't
    // apply so we never submit a stale pack_id on an upgrader challenge.
    setPack(null);
    setCard(null);
    setMinBetUsd("");
    setMinMultiplier("");
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
    if (kind === "card") {
      if (!pack?.id) {
        toast.error("Please select a pack");
        return;
      }
      if (!card?.id) {
        toast.error("Please select a card");
        return;
      }
    } else {
      const bet = parseFloat(minBetUsd);
      if (!Number.isFinite(bet) || bet <= 0) {
        toast.error("Enter a minimum bet greater than 0");
        return;
      }
      const mult = parseFloat(minMultiplier);
      if (!Number.isFinite(mult) || mult <= 0) {
        toast.error("Enter a minimum multiplier greater than 0");
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
          cardId: kind === "card" ? card?.id : undefined,
          minBetUsd: kind === "upgrader" ? parseFloat(minBetUsd) : undefined,
          minMultiplier: kind === "upgrader" ? parseFloat(minMultiplier) : undefined,
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

            {kind === "card" ? (
              <>
                <div className="space-y-2">
                  <Label className="text-xs">Pack (active)</Label>
                  <ItemPicker
                    type="pack"
                    value={pack}
                    onSelect={(item: SearchItem) => {
                      setPack({
                        id: item.id,
                        name: item.name,
                        imageUrl: item.imageUrl,
                        priceUsd: item.priceUsd,
                      });
                      // the card pool is per-pack — drop a card picked from the
                      // previous pack so we never submit a card not in this pack.
                      setCard(null);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Card (from pack)</Label>
                  <ItemPicker
                    type="card"
                    packId={pack?.id}
                    disabled={!pack}
                    placeholder={!pack ? "Select a pack first" : undefined}
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
              </>
            ) : (
              // Upgrader is card-agnostic: a winning play just has to bet at
              // least this much AND hit at least this multiplier.
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs">Min bet (USD)</Label>
                  <Input
                    type="number"
                    value={minBetUsd}
                    onChange={(e) => setMinBetUsd(e.target.value)}
                    placeholder="1.00"
                    min={0}
                    step="0.01"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Min multiplier</Label>
                  <Input
                    type="number"
                    value={minMultiplier}
                    onChange={(e) => setMinMultiplier(e.target.value)}
                    placeholder="2"
                    min={0}
                    step="0.0001"
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
