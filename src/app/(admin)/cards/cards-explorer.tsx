"use client";

import * as React from "react";
import { Library, ArrowRight, SearchX, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { CardTile, TileDataRow } from "@/components/card-tile";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  EntityTable,
  type EntityColumn,
  EntityNameCell,
  ValueCell,
  RarityDot,
  MetaChip,
  SelectionToolbar,
  useEntitySelection,
  EmptyState,
} from "@/components/entity-surface";
import { resolveEntityView, type EntityView } from "@/components/entity-surface";
import type { CardListItem } from "@/lib/queries/cards";
import { MoveToSetDialog } from "./move-to-set-dialog";
import { DeleteCardsDialog } from "./delete-cards-dialog";
import { CardInspectorSheet } from "./card-inspector-sheet";
import { fetchCardIdsForFilter } from "./load-actions";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  CardsExplorer  (pokewin-admin · /cards)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The client shell for the catalog list. Replaces the old thumbnail-only
 * `CardsGrid` with the master-detail IA the discovery recommended, composed
 * entirely from the shared `entity-surface` foundation:
 *
 *   - A dense, sortable TABLE (default) over `EntityTable` with a small
 *     artwork thumbnail + sortable Name / Set / Rarity / Price / Card# /
 *     In-Packs columns — so every scalar field is readable + comparable
 *     instead of truncated in a 10-wide image grid. Sort headers wire the
 *     EXISTING `getCards` sortBy/sortOrder (fixing the unreachable-sort gap).
 *   - A one-click GALLERY view (the existing `CardTile` grid, untouched, also
 *     used by /packs/[id]) for artwork browsing — `?view=` driven so the
 *     server renders the right primitive with no wrong-view flash.
 *   - A right-side INSPECTOR sheet opened on row/tile click for a fast detail
 *     preview + inline price edit, WITHOUT leaving the list. The full
 *     `/cards/[id]` page stays the deep-link.
 *   - PERSISTENT, cross-page bulk selection (shift-range + select-all-visible +
 *     select-all-matching) feeding the SAME `bulkMoveCardsToSet` action — the
 *     headline grooming flow, now reachable for backlogs larger than one page.
 *
 * Selection state lives in `useEntitySelection` so it survives pagination.
 * The inspector + move dialog defer their bodies (lazy) so opening either
 * never blocks the list.
 */
/**
 * The resolved filter predicate for the current view — passed down from the
 * server page (which already resolved the active-set tab slug → UUID and the
 * effective setId) so the "select all matching" action applies the EXACT same
 * predicate as the visible list, without re-resolving the slug client-side.
 */
export type CardsFilter = {
  search?: string;
  rarity?: string;
  setId?: string;
  minPrice?: string;
  maxPrice?: string;
};

export function CardsExplorer({
  data,
  total,
  view: viewParam,
  filter,
  isAdmin,
}: {
  data: CardListItem[];
  /** Total rows matching the current filter (across all pages). */
  total: number;
  /** The `?view=` value resolved server-side (table | grid). */
  view: string;
  /** Resolved filter predicate (active-set already folded in). */
  filter: CardsFilter;
  /**
   * Whether the current admin holds the `admin` role. Gates the bulk Delete
   * affordance in the selection toolbar — non-admins never see it (and the
   * `deleteCards` server action rejects them regardless via `requireAdmin`).
   */
  isAdmin: boolean;
}) {
  const view: EntityView = resolveEntityView(viewParam);

  const visibleKeys = React.useMemo(() => data.map((c) => c.id), [data]);
  const sel = useEntitySelection(visibleKeys);

  const [moveOpen, setMoveOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [selectAllPending, startSelectAll] = React.useTransition();

  // Inspector target — the card whose detail sheet is open. Null = closed.
  const [inspectId, setInspectId] = React.useState<string | null>(null);
  const inspectRow = React.useMemo(
    () => data.find((c) => c.id === inspectId) ?? null,
    [data, inspectId],
  );

  // After a successful move the moved cards left their previous bucket, so
  // clear the selection; the page-level refresh re-fetches the slice.
  const handleMoved = React.useCallback(() => {
    sel.clear();
  }, [sel]);

  // "Select all N matching the filter" — the discovery's backlog-grooming
  // affordance. `bulkMoveCardsToSet` accepts up to 500 ids, so we pull at most
  // that many; the toolbar only offers this when total > visible.
  const SELECT_ALL_CAP = 500;
  const handleSelectAllMatching = React.useCallback(() => {
    startSelectAll(async () => {
      try {
        const ids = await fetchCardIdsForFilter(filter, SELECT_ALL_CAP);
        sel.selectKeys(ids);
        if (total > SELECT_ALL_CAP) {
          toast.message(
            `Selected the first ${formatNumber(SELECT_ALL_CAP)} of ${formatNumber(total)} matching cards (the per-move cap).`,
          );
        }
      } catch {
        toast.error("Couldn't select matching cards");
      }
    });
  }, [filter, sel, total]);

  const toolbarActions = sel.count > 0 && (
    <>
      {isAdmin && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setDeleteOpen(true)}
          className="h-8 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"
        >
          <Trash2 className="size-3.5" />
          Delete
        </Button>
      )}
      <Button size="sm" onClick={() => setMoveOpen(true)} className="h-8">
        <Library className="size-3.5" />
        Move to set
        <ArrowRight className="size-3.5" />
      </Button>
    </>
  );

  return (
    <div className="space-y-3">
      <SelectionToolbar
        selectedCount={sel.count}
        visibleCount={visibleKeys.length}
        allVisibleSelected={sel.allVisibleSelected}
        someVisibleSelected={sel.someVisibleSelected}
        onToggleAllVisible={sel.toggleAllVisible}
        onClear={sel.clear}
        actions={toolbarActions}
        matchingTotal={total}
        onSelectAllMatching={handleSelectAllMatching}
        selectAllPending={selectAllPending}
        noun="card"
      />

      {data.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-card/30">
          <EmptyState
            icon={SearchX}
            title="No cards match your filters"
            description="Try a different rarity, set, or price range."
          />
        </div>
      ) : view === "grid" ? (
        <CardsGalleryView
          data={data}
          selected={sel.selected}
          onToggleOne={(id, next) => sel.toggle(id, next, false)}
          onOpenInspector={setInspectId}
        />
      ) : (
        <CardsTableView
          data={data}
          selection={sel}
          activeRowKey={inspectId}
          onOpenInspector={setInspectId}
        />
      )}

      <MoveToSetDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        selectedCardIds={Array.from(sel.selected)}
        onMoved={handleMoved}
      />

      {isAdmin && (
        <DeleteCardsDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          selectedCardIds={Array.from(sel.selected)}
          onDeleted={handleMoved}
        />
      )}

      <CardInspectorSheet
        cardId={inspectId}
        // Pass the row we already have so the header paints instantly with the
        // name/image while the lean detail streams in behind it.
        seed={
          inspectRow
            ? {
                name: inspectRow.name,
                imageUrl: inspectRow.imageUrl,
                rarity: inspectRow.rarity,
                setName: inspectRow.setName,
              }
            : null
        }
        onOpenChange={(open) => {
          if (!open) setInspectId(null);
        }}
      />
    </div>
  );
}

// ─── Table view ──────────────────────────────────────────────────────────────

function CardsTableView({
  data,
  selection,
  activeRowKey,
  onOpenInspector,
}: {
  data: CardListItem[];
  selection: ReturnType<typeof useEntitySelection>;
  activeRowKey: string | null;
  onOpenInspector: (id: string) => void;
}) {
  const columns = React.useMemo<EntityColumn<CardListItem>[]>(
    () => [
      {
        id: "name",
        header: "Card",
        sortKey: "name",
        cell: (c) => (
          <EntityNameCell
            imageUrl={c.imageUrl}
            name={c.name}
            secondary={
              c.cardNumber ? (
                <span className="font-mono">#{c.cardNumber}</span>
              ) : (
                <span className="capitalize">{c.type}</span>
              )
            }
            badge={<RarityDot rarity={c.rarity} />}
          />
        ),
      },
      {
        id: "set",
        header: "Set",
        hideBelow: "md",
        cell: (c) =>
          c.setName ? (
            <span className="truncate text-sm">{c.setName}</span>
          ) : (
            <span className="text-xs text-muted-foreground/70">Unassigned</span>
          ),
      },
      {
        id: "rarity",
        header: "Rarity",
        hideBelow: "lg",
        cell: (c) =>
          c.rarity ? (
            <span className="truncate text-sm capitalize">{c.rarity}</span>
          ) : (
            <span className="text-muted-foreground/70">—</span>
          ),
      },
      {
        id: "price",
        header: "Price",
        sortKey: "price",
        align: "right",
        width: "120px",
        noTruncate: true,
        cell: (c) => (
          <ValueCell muted={c.priceUsd <= 0}>
            {c.priceUsd > 0 ? formatCurrency(c.priceUsd) : "—"}
          </ValueCell>
        ),
      },
      {
        id: "cardNumber",
        header: "Card #",
        hideBelow: "xl",
        align: "right",
        width: "110px",
        cell: (c) =>
          c.cardNumber ? (
            <span className="font-mono text-xs tabular-nums">
              {c.cardNumber}
            </span>
          ) : (
            <span className="text-muted-foreground/70">—</span>
          ),
      },
      {
        id: "hp",
        header: "HP",
        hideBelow: "xl",
        align: "right",
        width: "70px",
        noTruncate: true,
        cell: (c) =>
          c.hp != null ? (
            <span className="text-sm tabular-nums">{formatNumber(c.hp)}</span>
          ) : (
            <span className="text-muted-foreground/70">—</span>
          ),
      },
      {
        id: "inPacks",
        header: "In Packs",
        align: "right",
        width: "100px",
        noTruncate: true,
        cell: (c) =>
          c.inPacks > 0 ? (
            <MetaChip>{formatNumber(c.inPacks)}</MetaChip>
          ) : (
            <span className="text-xs text-muted-foreground/70">—</span>
          ),
      },
    ],
    [],
  );

  return (
    <EntityTable
      rows={data}
      columns={columns}
      rowKey={(c) => c.id}
      onRowClick={(c) => onOpenInspector(c.id)}
      activeRowKey={activeRowKey}
      selectable
      selected={selection.selected}
      onToggleRow={selection.toggle}
      onToggleAllVisible={selection.toggleAllVisible}
    />
  );
}

// ─── Gallery view ────────────────────────────────────────────────────────────

function CardsGalleryView({
  data,
  selected,
  onToggleOne,
  onOpenInspector,
}: {
  data: CardListItem[];
  selected: Set<string>;
  onToggleOne: (id: string, next: boolean) => void;
  onOpenInspector: (id: string) => void;
}) {
  return (
    <div
      className={cn(
        // Dense grid: 2 → 3 → 5 → 7 → 10 columns (matches the skeleton).
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
            {/* The tile opens the INSPECTOR (not a navigation) so artwork
                browsing keeps list context — same fast-preview model as the
                table. The whole card is a button; the checkbox overlay stops
                propagation so selecting never opens the sheet. */}
            <button
              type="button"
              onClick={() => onOpenInspector(card.id)}
              className="block w-full text-left"
              aria-label={`Inspect ${card.name}`}
            >
              <CardTile
                id={card.id}
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
            </button>
            {/* Checkbox overlay — sits above the inspector button, stops
                propagation so clicking it toggles selection rather than
                opening the sheet. Visible when selected; faded-in on
                hover/focus otherwise so the grid stays clean at idle. */}
            <div
              className={cn(
                "absolute left-3 top-3 z-10",
                isSelected
                  ? "opacity-100"
                  : "opacity-0 group-hover/tile:opacity-100 focus-within:opacity-100",
              )}
            >
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                }}
                className="flex size-5 items-center justify-center rounded-md border bg-background/95 shadow-sm ring-1 ring-border backdrop-blur-sm"
              >
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={(v) => onToggleOne(card.id, Boolean(v))}
                  aria-label={`Select ${card.name}`}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
