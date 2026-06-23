"use client";

import * as React from "react";
import {
  ShieldCheck,
  SearchX,
  Trash2,
  HelpCircle,
  Package,
  ArrowUpCircle,
  Boxes,
  BadgeCheck,
} from "lucide-react";
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
  resolveEntityView,
  type EntityView,
} from "@/components/entity-surface";
import type { CardListItem } from "@/lib/queries/cards";
import {
  getCardUsageFlagsForCards,
  type CardUsageFlags,
} from "./_actions";
import { DeleteUnusedDialog } from "./delete-all-unused-dialog";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Pack Studio · Card Editor — explorer
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Route-local twin of the `/cards` explorer, composed from the SAME shared
 * `entity-surface` foundation, but extended with the Card Editor's two
 * deliverables:
 *
 *   1. A USAGE / SAFETY column — `inPacks` usage plus a safe / blocked badge
 *      sourced from `getCardSafety` (the shared, admin-only reference check)
 *      for the VISIBLE rows. The badge degrades to "unknown" when the caller
 *      isn't an admin (the reference read is admin-only by design) — usage
 *      (`inPacks`) still renders for everyone.
 *   2. A "Delete all unused" flow — opens a dialog that recomputes the safe set
 *      across the active filter (`loadCardIdsForUnusedFilter`), shows the
 *      blocked cards + reason codes, then deletes only the unreferenced set via
 *      the admin-only, audited `deletePackStudioCards`.
 *
 * The "Unused only" filter (`?unused=1`) narrows the VISIBLE rows to the
 * deletable subset client-side once the visible safety map has resolved; the
 * server still returns the normal filtered slice (the safety check is a
 * per-page overlay, never a full-table scan).
 *
 * Selection survives pagination (`useEntitySelection`). No MAIN writes happen
 * on render — only the explicit "Delete all unused" action mutates, and only
 * through the audited server action.
 */

/** Resolved per-card usage state for the visible page. */
type SafetyState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "ready";
      /** ids with NO usage of any kind → safe to delete. Single source of truth. */
      deletable: Set<string>;
      /** full usage flags per card (which categories it appears in). */
      flags: Map<string, CardUsageFlags>;
    };

/**
 * One usage category to render as its own scannable badge. Neutral catalog
 * state (no money), so house-neutral muted chips — NOT the red/green money
 * palette. The icon is distinct from the emerald `ShieldCheck` safe badge.
 */
const USAGE_CATEGORIES: {
  key: keyof Pick<
    CardUsageFlags,
    "inPacks" | "inUpgrader" | "inInventory" | "inProvablyFair"
  >;
  label: string;
  Icon: typeof Package;
  title: string;
}[] = [
  { key: "inPacks", label: "Pack", Icon: Package, title: "Used in at least one pack" },
  {
    key: "inUpgrader",
    label: "Upgrader",
    Icon: ArrowUpCircle,
    title: "Used by the upgrader (output pool or target)",
  },
  {
    key: "inInventory",
    label: "Inventory",
    Icon: Boxes,
    title: "Held in at least one user's inventory",
  },
  {
    key: "inProvablyFair",
    label: "PF",
    Icon: BadgeCheck,
    title: "Referenced by provably-fair history",
  },
];

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
  unusedOnly,
  isAdmin,
}: {
  data: CardListItem[];
  total: number;
  view: string;
  filter: CardsFilter;
  /** Whether the `?unused=1` filter is active (narrows visible rows). */
  unusedOnly: boolean;
  /** Gates the destructive "Delete all unused" affordance (admin-only). */
  isAdmin: boolean;
}) {
  const view: EntityView = resolveEntityView(viewParam);

  const visibleIds = React.useMemo(() => data.map((c) => c.id), [data]);
  const visibleKey = React.useMemo(() => visibleIds.join(","), [visibleIds]);

  // ── Per-page safety overlay ──────────────────────────────────────────────
  // Resolve the safe/blocked split for exactly the visible rows. Admin-only at
  // the data layer; for a non-admin the call throws and we mark the overlay
  // "unavailable" so the badge degrades gracefully (usage still shows).
  const [safety, setSafety] = React.useState<SafetyState>({ kind: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    if (visibleIds.length === 0) {
      setSafety({
        kind: "ready",
        deletable: new Set(),
        flags: new Map(),
      });
      return;
    }
    setSafety({ kind: "loading" });
    getCardUsageFlagsForCards(visibleIds)
      .then((res) => {
        if (cancelled) return;
        const flags = new Map<string, CardUsageFlags>(
          res.map((f) => [f.id, f]),
        );
        const deletable = new Set(
          res.filter((f) => f.safeToDelete).map((f) => f.id),
        );
        setSafety({ kind: "ready", deletable, flags });
      })
      .catch(() => {
        if (!cancelled) setSafety({ kind: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [visibleKey, visibleIds]);

  // The rows actually shown — the "Unused only" filter narrows to the deletable
  // subset once safety has resolved (before that, show the unfiltered slice so
  // the operator isn't staring at an empty table while the overlay loads).
  const rows = React.useMemo(() => {
    if (!unusedOnly || safety.kind !== "ready") return data;
    return data.filter((c) => safety.deletable.has(c.id));
  }, [data, unusedOnly, safety]);

  const rowIds = React.useMemo(() => rows.map((c) => c.id), [rows]);
  const sel = useEntitySelection(rowIds);

  const [deleteOpen, setDeleteOpen] = React.useState(false);

  // The count of deletable cards on THIS page — drives the toolbar copy.
  const visibleDeletableCount = React.useMemo(() => {
    if (safety.kind !== "ready") return null;
    return data.reduce(
      (n, c) => (safety.deletable.has(c.id) ? n + 1 : n),
      0,
    );
  }, [data, safety]);

  const onDeleted = React.useCallback(() => {
    sel.clear();
  }, [sel]);

  const toolbarActions = isAdmin && (
    <Button
      size="sm"
      onClick={() => setDeleteOpen(true)}
      className="h-8 bg-emerald-500 text-white hover:bg-emerald-600"
    >
      <Trash2 className="size-3.5" />
      Delete all unused
      {visibleDeletableCount != null && visibleDeletableCount > 0 ? (
        <span className="tabular-nums">
          ({formatNumber(visibleDeletableCount)}+)
        </span>
      ) : null}
    </Button>
  );

  return (
    <div className="space-y-3">
      {/* The toolbar is always shown so "Delete all unused" stays reachable
          even with nothing selected — it operates on the FILTER, not the
          selection. Selection still feeds the visible-count label. */}
      <SelectionToolbar
        selectedCount={sel.count}
        visibleCount={rowIds.length}
        allVisibleSelected={sel.allVisibleSelected}
        someVisibleSelected={sel.someVisibleSelected}
        onToggleAllVisible={sel.toggleAllVisible}
        onClear={sel.clear}
        actions={toolbarActions || undefined}
        noun="card"
      />

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-card/30">
          <EmptyState
            icon={unusedOnly ? ShieldCheck : SearchX}
            title={
              unusedOnly
                ? "No safely-deletable cards here"
                : "No cards match your filters"
            }
            description={
              unusedOnly
                ? "Every card on this page is still referenced by a pack, inventory, the upgrader, or a provably-fair record."
                : "Try a different rarity, set, or price range."
            }
          />
        </div>
      ) : view === "grid" ? (
        <CardsGalleryView
          data={rows}
          selected={sel.selected}
          safety={safety}
          onToggleOne={(id, next) => sel.toggle(id, next, false)}
        />
      ) : (
        <CardsTableView data={rows} selection={sel} safety={safety} />
      )}

      {isAdmin && (
        <DeleteUnusedDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          filter={filter}
          matchingTotal={total}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}

// ─── Safety badge ────────────────────────────────────────────────────────────

/** One neutral muted category chip — house-neutral, never the money palette. */
function UsageChip({
  label,
  Icon,
  title,
}: {
  label: string;
  Icon: typeof Package;
  title: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
    >
      <Icon className="size-3" />
      {label}
    </span>
  );
}

/**
 * Per-card usage display: an emerald "Safe to delete" badge when the card is in
 * NONE of the reference classes, otherwise a compact cluster of one neutral chip
 * per category the card is actually in (Pack / Upgrader / Inventory / PF). The
 * `safeToDelete` notion comes from the shared reference check — the same one the
 * "Unused only" filter + delete flow use.
 */
function SafetyBadge({
  id,
  inPacks,
  safety,
}: {
  id: string;
  inPacks: number;
  safety: SafetyState;
}) {
  if (safety.kind === "loading") {
    return (
      <span className="text-xs text-muted-foreground/60">Checking…</span>
    );
  }
  if (safety.kind === "unavailable") {
    // Reference read is admin-only — usage (`inPacks`) still shows elsewhere.
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-muted-foreground/70"
        title="The usage check is admin-only — pack usage is still shown."
      >
        <HelpCircle className="size-3" />
        Unknown
      </span>
    );
  }
  if (safety.deletable.has(id)) {
    // Safe to delete = unreferenced. Neutral catalog-hygiene state (no money),
    // so the affirmative emerald reads as "good to clean up".
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="size-3" />
        Safe to delete
      </span>
    );
  }
  const flags = safety.flags.get(id);
  const active = flags
    ? USAGE_CATEGORIES.filter((cat) => flags[cat.key])
    : [];
  if (active.length === 0) {
    // Defensive: not deletable but no flag resolved — keep a clear "in use" sign.
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
        In use
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {active.map((cat) => (
        <UsageChip
          key={cat.key}
          label={cat.label}
          Icon={cat.Icon}
          title={
            cat.key === "inPacks" && inPacks > 0
              ? `${cat.title} (${formatNumber(inPacks)} pack${inPacks === 1 ? "" : "s"})`
              : cat.title
          }
        />
      ))}
    </div>
  );
}

// ─── Table view ──────────────────────────────────────────────────────────────

function CardsTableView({
  data,
  selection,
  safety,
}: {
  data: CardListItem[];
  selection: ReturnType<typeof useEntitySelection>;
  safety: SafetyState;
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
      {
        id: "safety",
        header: "Usage / Safety",
        align: "right",
        width: "160px",
        noTruncate: true,
        cell: (c) => (
          <SafetyBadge id={c.id} inPacks={c.inPacks} safety={safety} />
        ),
      },
    ],
    [safety],
  );

  return (
    <EntityTable
      rows={data}
      columns={columns}
      rowKey={(c) => c.id}
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
  safety,
  onToggleOne,
}: {
  data: CardListItem[];
  selected: Set<string>;
  safety: SafetyState;
  onToggleOne: (id: string, next: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "grid gap-2.5",
        "grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-10",
      )}
    >
      {data.map((card) => {
        const rarityLabel = card.rarity ?? null;
        const setLabel = card.setName ?? null;
        const isSelected = selected.has(card.id);

        return (
          <div key={card.id} className="group/tile relative">
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
                  <TileDataRow
                    label={
                      card.inPacks > 0 ? (
                        <span>{formatNumber(card.inPacks)} in packs</span>
                      ) : (
                        <span className="text-muted-foreground/60">
                          Not in packs
                        </span>
                      )
                    }
                    value={
                      <SafetyBadge
                        id={card.id}
                        inPacks={card.inPacks}
                        safety={safety}
                      />
                    }
                  />
                </>
              }
            />
            {/* Selection overlay — toggles selection without navigating. */}
            <div
              className={cn(
                "absolute left-3 top-3 z-10",
                isSelected
                  ? "opacity-100"
                  : "opacity-0 group-hover/tile:opacity-100 focus-within:opacity-100",
              )}
            >
              <div className="flex size-5 items-center justify-center rounded-md border bg-background/95 shadow-sm ring-1 ring-border backdrop-blur-sm">
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
