"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { CardImage } from "@/components/card-image";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import type { UpgraderOutputCard } from "@/lib/backend-api";
import {
  UPGRADER_OUTPUT_COLORS,
  type UpgraderOutputColor,
} from "./colors";
import {
  removeUpgraderOutput,
  setUpgraderOutputColor,
  setUpgraderOutputEnabled,
} from "./actions";

/**
 * Swatch hexes mirror auraHex values in the game frontend's
 * CARD_RARITY_THEME_MAP (src/lib/cards/theme/card-theme.ts). These are
 * visual cues only — the persisted value is the named tone string
 * ("gray", "blue", ...), not the hex. Keep this map in sync with the
 * upgrader/game UI to avoid admin/player color drift.
 */
const COLOR_SWATCH: Record<UpgraderOutputColor, string> = {
  gray: "#6E7199",
  white: "#F5F9FF",
  blue: "#00B4F0",
  green: "#5EC22E",
  purple: "#A855F7",
  red: "#FF4545",
  gold: "#FFD700",
};

// Sentinel value used in the Select dropdown to represent the "no
// override" state — base-ui Select needs a string for every option, so
// we map "default" ↔ null at the action-call boundary.
const COLOR_DEFAULT_SENTINEL = "default";

function ColorSwatch({ color }: { color: UpgraderOutputColor | null }) {
  if (color === null) {
    return (
      <span
        aria-hidden
        className="inline-block size-3 shrink-0 rounded-full border border-dashed border-muted-foreground/60"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-block size-3 shrink-0 rounded-full border border-border/40 shadow-sm"
      style={{ backgroundColor: COLOR_SWATCH[color] }}
    />
  );
}

const RARITY_BADGE: Record<string, string> = {
  common: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  uncommon:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  rare: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  "ultra rare":
    "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  secret:
    "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
};

function rarityClass(rarity: string | null): string {
  return RARITY_BADGE[(rarity ?? "").toLowerCase()] ?? "";
}

export function UpgraderOutputCardsGrid({
  data,
}: {
  data: UpgraderOutputCard[];
}) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed bg-card/30 px-6 py-16 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-muted/40">
          <Search className="size-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">No cards in the upgrader pool yet</p>
        <p className="text-xs text-muted-foreground">
          Click &quot;Add Cards&quot; above to populate the output pool.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid gap-3",
        "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8",
      )}
    >
      {data.map((card) => (
        <UpgraderOutputCardTile key={card.id} card={card} />
      ))}
    </div>
  );
}

/**
 * Narrow a string from the backend to a known UpgraderOutputColor. We
 * treat unknown / malformed values as if the override were unset — they
 * still show up as "Default" in the dropdown and the next save will
 * persist a valid value (or clear it).
 */
function asKnownColor(value: string | null): UpgraderOutputColor | null {
  if (value === null) return null;
  return (UPGRADER_OUTPUT_COLORS as readonly string[]).includes(value)
    ? (value as UpgraderOutputColor)
    : null;
}

function UpgraderOutputCardTile({ card }: { card: UpgraderOutputCard }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [removeOpen, setRemoveOpen] = useState(false);

  const currentColor = asKnownColor(card.color);

  const toggleEnabled = (next: boolean) => {
    startTransition(async () => {
      try {
        await setUpgraderOutputEnabled(card.id, next);
        toast.success(next ? "Card enabled" : "Card disabled");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update");
      }
    });
  };

  const handleColorChange = (sentinelOrColor: string | null) => {
    // base-ui's Select onValueChange may emit null when the value is
    // cleared programmatically. We collapse both null and the sentinel
    // string to the same "no override" branch.
    const next: UpgraderOutputColor | null =
      sentinelOrColor === null || sentinelOrColor === COLOR_DEFAULT_SENTINEL
        ? null
        : (sentinelOrColor as UpgraderOutputColor);

    // Skip the round-trip when the value didn't change — the Select fires
    // onValueChange on initial mount in some flows.
    if (next === currentColor) return;

    startTransition(async () => {
      try {
        await setUpgraderOutputColor(card.id, next);
        toast.success(
          next === null ? "Color cleared" : `Color set to ${next}`,
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update");
      }
    });
  };

  const handleRemove = () => {
    startTransition(async () => {
      try {
        await removeUpgraderOutput(card.id);
        toast.success("Card removed from pool");
        setRemoveOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove");
      }
    });
  };

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-2 rounded-xl border bg-card/40 p-2.5 transition-colors",
        !card.enabled && "opacity-60",
      )}
    >
      <CardImage
        src={card.image_url}
        alt={card.name}
        className={cn("w-full rounded-md", !card.enabled && "grayscale")}
      />

      <div className="flex flex-col gap-1 px-0.5">
        <p className="truncate text-xs font-medium leading-tight">
          {card.name}
        </p>
        <div className="flex items-center justify-between gap-1">
          {card.rarity ? (
            <Badge
              variant="outline"
              className={cn(
                "shrink-0 px-1 py-0 text-[9px] capitalize",
                rarityClass(card.rarity),
              )}
            >
              {card.rarity}
            </Badge>
          ) : (
            <span className="text-[10px] text-muted-foreground">—</span>
          )}
          <span className="text-[11px] font-semibold tabular-nums">
            {formatCurrency(card.price)}
          </span>
        </div>
      </div>

      <Select
        value={currentColor ?? COLOR_DEFAULT_SENTINEL}
        onValueChange={handleColorChange}
        disabled={isPending}
      >
        <SelectTrigger
          size="sm"
          className="h-7 w-full justify-between px-2 text-[11px]"
          aria-label="Card color override"
        >
          <SelectValue>
            <span className="flex items-center gap-1.5">
              <ColorSwatch color={currentColor} />
              <span className="capitalize">{currentColor ?? "Default"}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={COLOR_DEFAULT_SENTINEL}>
            <ColorSwatch color={null} />
            <span>Default</span>
          </SelectItem>
          {UPGRADER_OUTPUT_COLORS.map((c) => (
            <SelectItem key={c} value={c}>
              <ColorSwatch color={c} />
              <span className="capitalize">{c}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex items-center justify-between gap-2 border-t pt-2">
        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Switch
            checked={card.enabled}
            onCheckedChange={toggleEnabled}
            disabled={isPending}
            aria-label={card.enabled ? "Disable card" : "Enable card"}
          />
          <span>{card.enabled ? "Enabled" : "Disabled"}</span>
        </label>

        <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
          <AlertDialogTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                disabled={isPending}
                aria-label="Remove from pool"
              />
            }
          >
            {isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {card.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the card from the upgrader output pool. The card
                itself is not deleted — you can re-add it later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  handleRemove();
                }}
                disabled={isPending}
              >
                {isPending ? "Removing..." : "Remove"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
