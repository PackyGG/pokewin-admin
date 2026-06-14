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
import { Spinner } from "@/components/ux";
import { createReward } from "./actions";
import { PrizePicker } from "./prize-picker";
import type { SearchItem } from "./prize-search-actions";

type PackEntry = {
  _key: string;
  id: string;
  name?: string;
  imageUrl?: string | null;
  priceUsd?: number;
};

export function CreateRewardButton({ defaultType }: { defaultType?: "one_time" | "daily" | "balance" } = {}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [type, setType] = useState<"one_time" | "daily" | "balance">(defaultType ?? "one_time");
  const [levelRequired, setLevelRequired] = useState("");
  const [cashAmount, setCashAmount] = useState("");
  // Daily reward re-unlock threshold, entered as a percent (1 = 1%). Empty = 1% default.
  const [dailyUnlockPct, setDailyUnlockPct] = useState("");
  const [packs, setPacks] = useState<PackEntry[]>([]);

  function addPack() {
    setPacks((prev) => [...prev, { _key: crypto.randomUUID(), id: "" }]);
  }

  function removePack(index: number) {
    setPacks((prev) => prev.filter((_, i) => i !== index));
  }

  function updatePackItem(index: number, item: SearchItem) {
    setPacks((prev) =>
      prev.map((p, i) =>
        i === index
          ? { _key: p._key, id: item.id, name: item.name, imageUrl: item.imageUrl, priceUsd: item.priceUsd }
          : p,
      ),
    );
  }

  function resetForm() {
    setName("");
    setSlug("");
    setType(defaultType ?? "one_time");
    setLevelRequired("");
    setCashAmount("");
    setDailyUnlockPct("");
    setPacks([]);
  }

  function handleSubmit() {
    if (!name.trim()) {
      toast.error("Please enter a name");
      return;
    }
    if (!slug.trim()) {
      toast.error("Please enter a slug");
      return;
    }

    const validPacks = packs.filter((p) => p.id);

    startTransition(async () => {
      try {
        await createReward({
          name: name.trim(),
          slug: slug.trim(),
          type,
          levelRequired: levelRequired ? parseInt(levelRequired, 10) : undefined,
          packIds: validPacks.map((p) => p.id),
          cashAmount: cashAmount ? parseFloat(cashAmount) : undefined,
          dailyUnlockPercentage:
            type === "daily" && dailyUnlockPct
              ? parseFloat(dailyUnlockPct) / 100
              : undefined,
        });
        toast.success("Reward created");
        setOpen(false);
        resetForm();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to create reward");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        Create Reward
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Reward</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily Login Bonus" />
          </div>
          <div className="space-y-2">
            <Label>Slug</Label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="daily-login-bonus" />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => v && setType(v as typeof type)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="one_time">One Time</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="balance">Balance</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Level Required</Label>
              <Input type="number" value={levelRequired} onChange={(e) => setLevelRequired(e.target.value)} placeholder="0" min={0} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Cash Amount (optional)</Label>
            <Input type="number" value={cashAmount} onChange={(e) => setCashAmount(e.target.value)} placeholder="0.00" min={0} step="0.01" />
          </div>

          {type === "daily" && (
            <div className="space-y-2">
              <Label>Re-unlock Threshold (%)</Label>
              <Input
                type="number"
                value={dailyUnlockPct}
                onChange={(e) => setDailyUnlockPct(e.target.value)}
                placeholder="1"
                min={0}
                step="0.01"
              />
              <p className="text-xs text-muted-foreground">
                Percent of the level&apos;s wager requirement a user must re-earn to
                re-open this pack after its 30-day period ends. Leave blank for the
                default (1%).
              </p>
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Packs</Label>
              <Button type="button" variant="outline" size="sm" onClick={addPack}>
                <Plus className="mr-1 size-3" /> Add Pack
              </Button>
            </div>
            {packs.map((pack, i) => (
              <div key={pack._key} className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <Label className="text-xs">Pack #{i + 1}</Label>
                  <PrizePicker
                    type="pack"
                    value={pack.id ? { id: pack.id, name: pack.name, imageUrl: pack.imageUrl, priceUsd: pack.priceUsd } : null}
                    onSelect={(item) => updatePackItem(i, item)}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-9"
                  onClick={() => removePack(i)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
            {packs.length === 0 && (
              <p className="text-sm text-muted-foreground">No packs added yet.</p>
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
