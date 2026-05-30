"use client";

import { useCallback, useMemo, useState } from "react";
import { ArrowRight, Library, SearchX, X } from "lucide-react";
import { CardTile, TileDataRow } from "@/components/card-tile";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { CardListItem, SetForMoveDialog } from "@/lib/queries/cards";
import { MoveToSetDialog } from "./move-to-set-dialog";

/**
 * Compact 10-per-row catalog grid with checkbox selection. Each tile
 * delegates to the shared <CardTile /> so the visual vocabulary stays in
 * lockstep with the card grid rendered inside /packs/[id].
 *
 * Selection model:
 *   - The header strip carries a "select-all-visible" master checkbox.
 *   - Each tile gets a top-left checkbox overlay that toggles selection
 *     for that card. The checkbox swallows the click so the tile's link
 *     still works for everything else.
 *   - When `selected.size > 0`, the strip switches to a sticky bulk
 *     toolbar showing "N selected", a Clear button, and "Move to set…".
 */
export function CardsGrid({
  data,
  sets,
  seriesOptions,
}: {
  data: CardListItem[];
  sets: SetForMoveDialog[];
  seriesOptions: string[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);

  const visibleIds = useMemo(() => data.map((c) => c.id), [data]);

  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected =
    !allVisibleSelected && visibleIds.some((id) => selected.has(id));

  const toggleOne = useCallback((id: string, next: boolean) => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }, []);

  const toggleAllVisible = useCallback(
    (next: boolean) => {
      setSelected((prev) => {
        const copy = new Set(prev);
        if (next) {
          for (const id of visibleIds) copy.add(id);
        } else {
          for (const id of visibleIds) copy.delete(id);
        }
        return copy;
      });
    },
    [visibleIds],
  );

  const clearAll = useCallback(() => setSelected(new Set()), []);

  // After a successful move the moved cards no longer belong in their
  // previous bucket, so drop them from the selection. The page-level
  // `router.refresh()` re-fetches the grid.
  const handleMoved = useCallback(() => {
    setSelected(new Set());
  }, []);

  if (data.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed bg-card/30">
        <EmptyState
          icon={SearchX}
          title="No cards match your filters"
          description="Try a different rarity, set, or price range."
        />
      </div>
    );
  }

  const selectionCount = selected.size;
  const hasSelection = selectionCount > 0;

  return (
    <div className="space-y-3">
      {/* ── Selection toolbar ─────────────────────────────────────────
          Sits sticky to the page header so the operator can scroll the
          grid without losing the move button. Inactive state is a slim
          "Select all visible" row; active state swaps to a contrast
          panel with the move CTA. */}
      <div
        className={cn(
          "sticky top-2 z-20",
          "flex flex-col gap-2 rounded-xl border bg-background/95 backdrop-blur-md px-3 py-2 sm:flex-row sm:items-center sm:justify-between",
          hasSelection && "border-primary/40 bg-primary/[0.04]",
        )}
      >
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <Checkbox
              checked={allVisibleSelected}
              indeterminate={someVisibleSelected}
              onCheckedChange={(v) => toggleAllVisible(v)}
              aria-label="Select all visible cards"
            />
            <span>
              {hasSelection ? (
                <>
                  <span className="font-medium text-foreground tabular-nums">
                    {formatNumber(selectionCount)}
                  </span>{" "}
                  card{selectionCount === 1 ? "" : "s"} selected
                </>
              ) : (
                <>Select all visible ({formatNumber(visibleIds.length)})</>
              )}
            </span>
          </label>
        </div>

        {hasSelection && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={clearAll}
              className="h-8 px-2"
            >
              <X className="size-3.5" />
              Clear
            </Button>
            <Button
              size="sm"
              onClick={() => setDialogOpen(true)}
              className="h-8"
            >
              <Library className="size-3.5" />
              Move to set
              <ArrowRight className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

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
          const isSelected = selected.has(card.id);

          return (
            <div key={card.id} className="group/tile relative">
              <CardTile
                id={card.id}
                href={`/cards/${card.id}`}
                name={card.name}
                imageUrl={card.imageUrl}
                rarity={card.rarity}
                subtitle={setLabel ?? card.type ?? null}
                className={cn(
                  isSelected &&
                    "border-primary/60 ring-2 ring-primary/30 bg-primary/[0.04]",
                )}
                extraRows={
                  <>
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
              {/* Checkbox overlay — sits above the link, stops propagation
                  so clicking the checkbox doesn't navigate to /cards/[id].
                  Positioned top-left over the image so it doesn't fight
                  the price chip in the bottom-right corner. */}
              <div
                className={cn(
                  "absolute left-3 top-3 z-10",
                  // Visible by default when selected; faded-in on hover/focus
                  // for unselected tiles so the grid stays clean at idle.
                  isSelected
                    ? "opacity-100"
                    : "opacity-0 group-hover/tile:opacity-100 focus-within:opacity-100",
                )}
                // We use a named group (`group/tile` on the parent) so the
                // checkbox fades in on tile hover without conflicting with
                // CardTile's own internal `group` (used for image scale).
              >
                <div
                  // Stop propagation/prevent default so the underlying Link
                  // doesn't fire when the operator targets the checkbox.
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                  }}
                  className="flex size-5 items-center justify-center rounded-md border bg-background/95 shadow-sm ring-1 ring-border backdrop-blur-sm"
                >
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={(v) => toggleOne(card.id, v)}
                    aria-label={`Select ${card.name}`}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <MoveToSetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        selectedCardIds={Array.from(selected)}
        sets={sets}
        seriesOptions={seriesOptions}
        onMoved={handleMoved}
      />
    </div>
  );
}
