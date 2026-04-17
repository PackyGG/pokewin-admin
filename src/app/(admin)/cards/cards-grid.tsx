"use client";

import { Search } from "lucide-react";
import { CardTile, TileDataRow } from "@/components/card-tile";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { CardListItem } from "@/lib/queries/cards";

/**
 * Compact 10-per-row catalog grid. Each tile delegates to the shared
 * <CardTile /> so the visual vocabulary stays in lockstep with the card
 * grid rendered inside /packs/[id].
 *
 * Layout choices:
 *   - Image uses the 5/7 aspect defined in <CardTile />, which is a touch
 *     calmer than the old 3/4 and matches the natural TCG proportion.
 *   - Below the name we stack two sparse data rows (rarity + price, set +
 *     card number) in tabular-nums so numbers line up down the column.
 */
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
        const rarityLabel = card.rarity ?? null;
        const setLabel = card.setName ?? null;
        const cardNumber = card.cardNumber ?? null;

        return (
          <CardTile
            key={card.id}
            id={card.id}
            href={`/cards/${card.id}`}
            name={card.name}
            imageUrl={card.imageUrl}
            rarity={card.rarity}
            // Set name sits under the name as a muted subtitle. If we don't
            // have one fall back to the card type so the row isn't empty.
            subtitle={setLabel ?? card.type ?? null}
            extraRows={
              <>
                {/* Rarity + price row — rarity on the left reads like a
                    category label, price aligns right in tabular-nums. */}
                <TileDataRow
                  label={
                    rarityLabel ? (
                      <span className="capitalize">{rarityLabel}</span>
                    ) : (
                      "—"
                    )
                  }
                  value={
                    card.priceUsd > 0 ? (
                      formatCurrency(card.priceUsd)
                    ) : (
                      <span className="text-muted-foreground/60">—</span>
                    )
                  }
                />
                {/* Card # + HP (or type fallback) — secondary density row. */}
                {(cardNumber || card.hp != null) && (
                  <TileDataRow
                    label={
                      cardNumber ? (
                        <span className="font-mono">#{cardNumber}</span>
                      ) : (
                        card.type ?? "—"
                      )
                    }
                    value={
                      card.hp != null ? (
                        <span>
                          {card.hp}
                          <span className="text-muted-foreground/60">
                            {" "}
                            HP
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground/60 capitalize">
                          {card.type ?? "—"}
                        </span>
                      )
                    }
                  />
                )}
              </>
            }
          />
        );
      })}
    </div>
  );
}
