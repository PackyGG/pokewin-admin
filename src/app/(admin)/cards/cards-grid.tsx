"use client";

import Link from "next/link";
import { CardImage } from "@/components/card-image";
import { formatCurrency } from "@/lib/utils/format";
import { Badge } from "@/components/ui/badge";
import type { CardListItem } from "@/lib/queries/cards";

const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  uncommon: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  rare: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  "ultra rare": "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  secret: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
};

export function CardsGrid({ data }: { data: CardListItem[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-md border text-muted-foreground">
        No cards found.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-3">
      {data.map((card) => (
        <Link
          key={card.id}
          href={`/cards/${card.id}`}
          className="group"
        >
          <div className="relative mb-1.5">
            <CardImage
              src={card.imageUrl}
              alt={card.name}
              className="w-full rounded-md transition-transform duration-200 group-hover:scale-105"
            />
          </div>
          <h3 className="text-xs font-semibold truncate group-hover:text-primary transition-colors">
            {card.name}
          </h3>
          <div className="flex items-center gap-1 mt-0.5">
            <Badge variant="outline" className={`text-tiny ${(card.rarity ? RARITY_COLORS[card.rarity.toLowerCase()] : "") ?? ""}`}>
              {card.rarity ?? "Unknown"}
            </Badge>
            <span className="text-tiny">{formatCurrency(card.priceUsd)}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
