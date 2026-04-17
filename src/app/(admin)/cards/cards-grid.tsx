"use client";

import Link from "next/link";
import { Layers, Search } from "lucide-react";
import { CardImage } from "@/components/card-image";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { CardListItem } from "@/lib/queries/cards";

// Compact rarity colors — small dots/badges, not full pills. Matches the
// palette used across the admin (STATUS_COLORS style) but trimmed for
// density. Keys must be lowercased before lookup.
const RARITY_DOT: Record<string, string> = {
  common: "bg-zinc-400",
  uncommon: "bg-green-500",
  rare: "bg-blue-500",
  "ultra rare": "bg-purple-500",
  secret: "bg-yellow-500",
};

const RARITY_RING: Record<string, string> = {
  common: "ring-zinc-500/20",
  uncommon: "ring-green-500/30",
  rare: "ring-blue-500/30",
  "ultra rare": "ring-purple-500/40",
  secret: "ring-yellow-500/40",
};

function rarityKey(rarity: string | null): string {
  return (rarity ?? "").toLowerCase();
}

export function CardsGrid({ data }: { data: CardListItem[] }) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed bg-card/30 px-6 py-16 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-muted/40">
          <Search className="size-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">No cards match your filters</p>
        <p className="text-xs text-muted-foreground">
          Try a different rarity, set, or price range.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        // Dense grid: 2 → 3 → 5 → 7 → 10 columns.
        "grid gap-2.5",
        "grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-10",
      )}
    >
      {data.map((card) => {
        const key = rarityKey(card.rarity);
        const dot = RARITY_DOT[key] ?? "bg-muted-foreground/40";
        const ring = RARITY_RING[key] ?? "ring-border";
        return (
          <Link
            key={card.id}
            href={`/cards/${card.id}`}
            className={cn(
              "group relative flex flex-col overflow-hidden rounded-xl border bg-card/50",
              "transition-all duration-200",
              "motion-safe:hover:-translate-y-0.5 hover:shadow-md hover:bg-card hover:border-primary/40",
            )}
          >
            {/* Rarity accent line — a hair on top, tinted by rarity. */}
            <div className={cn("h-0.5 w-full", dot)} aria-hidden />

            {/* Image box — padded inside the container, NOT edge-to-edge. */}
            <div className="relative px-2 pt-2">
              <div
                className={cn(
                  "relative overflow-hidden rounded-lg bg-muted/40 ring-1",
                  ring,
                )}
                style={{ aspectRatio: "3 / 4" }}
              >
                <CardImage
                  src={card.imageUrl}
                  alt={card.name}
                  className="absolute inset-0 size-full motion-safe:transition-transform motion-safe:duration-200 motion-safe:group-hover:scale-[1.03]"
                />

                {/* Tiny price chip over the image bottom-right */}
                {card.priceUsd > 0 && (
                  <div className="absolute bottom-1 right-1 rounded-md bg-background/85 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums shadow-sm ring-1 ring-border backdrop-blur-sm">
                    {formatCurrency(card.priceUsd)}
                  </div>
                )}
              </div>
            </div>

            {/* Footer: name + rarity dot. Kept tight to max density. */}
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <span
                className={cn("size-1.5 shrink-0 rounded-full", dot)}
                aria-hidden
              />
              <h3 className="min-w-0 flex-1 truncate text-[11px] font-medium leading-tight group-hover:text-primary">
                {card.name}
              </h3>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/** Re-export the icon so the page can reuse the same Layers icon in headings. */
export { Layers as CardsIcon };
