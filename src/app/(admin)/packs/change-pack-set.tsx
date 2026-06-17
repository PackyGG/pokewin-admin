"use client";

import { useEffect, useState, useTransition } from "react";
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
import { setPackSet, getPackSetForEdit } from "./actions";

// The Set axis (card pool) — independent of pack_type (official/reward/…)
// and tags (%1/%5/%10/50-50). Order matches the /packs tabs.
const POOL_OPTIONS: { value: string; label: string }[] = [
  { value: "pokemon", label: "Pokémon" },
  { value: "onepiece", label: "One Piece" },
  { value: "rewards", label: "Rewards" },
  { value: "meme", label: "Meme" },
];

export function ChangePackSet({ packId }: { packId: string }) {
  const router = useRouter();
  const [current, setCurrent] = useState<string | null>(null);
  const [value, setValue] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    getPackSetForEdit(packId)
      .then((s) => {
        if (!active) return;
        setCurrent(s);
        setValue(s ?? "");
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [packId]);

  function save() {
    if (!value || value === current) return;
    startTransition(async () => {
      try {
        const res = await setPackSet(packId, value);
        setCurrent(res.set);
        toast.success(
          `Pack set changed to ${
            POOL_OPTIONS.find((o) => o.value === res.set)?.label ?? res.set
          }`,
        );
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to change pack set");
      }
    });
  }

  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <Layers className="size-4" />
        Pack Set
      </h3>
      <p className="text-xs text-muted-foreground">
        Which pool tab (Pokémon / One Piece / Rewards / Meme) this pack is sorted
        under on /packs. This is its own axis — separate from the pack type
        (official / reward / …) and the %1 / %5 / %10 / 50-50 tags. It only
        changes the pack&apos;s category; it does NOT move or change any cards.
        Packs with no explicit set fall back to being grouped by the sets of
        their cards.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label>Set</Label>
          <Select
            value={value}
            onValueChange={(v) => v && setValue(v)}
            disabled={!loaded || isPending}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder={loaded ? "Auto (from cards)" : "Loading…"} />
            </SelectTrigger>
            <SelectContent>
              {POOL_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!value || value === current || isPending}
          onClick={save}
        >
          {isPending ? "Saving…" : "Save set"}
        </Button>
      </div>
      {loaded && current === null && (
        <p className="text-xs text-muted-foreground">
          Currently auto-classified from this pack&apos;s cards.
        </p>
      )}
    </div>
  );
}
