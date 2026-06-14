"use client";

import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Gem,
  Loader2,
  Package,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { CardImage } from "@/components/card-image";
import { EmptyState } from "@/components/empty-state";
import { InlineError } from "@/components/entity-surface/inline-error";
import { fetchInventory } from "./actions";
import { InventoryItemDeleteDialog } from "./inventory-item-delete-dialog";
import { InventoryBulkDeleteDialog } from "./inventory-bulk-delete-dialog";
import {
  inventorySourceLabel,
  type InventoryItem,
  type PaginatedInventory,
} from "./user-tabs-types";

const INVENTORY_RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-700/90 text-zinc-100",
  uncommon: "bg-emerald-700/90 text-emerald-100",
  rare: "bg-blue-700/90 text-blue-100",
  "ultra rare": "bg-purple-700/90 text-purple-100",
  "secret rare": "bg-yellow-600/90 text-yellow-100",
  legendary: "bg-orange-600/90 text-orange-100",
  holo: "bg-cyan-700/90 text-cyan-100",
  secret: "bg-pink-700/90 text-pink-100",
};

export const InventoryGrid = React.memo(function InventoryGrid({
  userId,
  initialInventory,
  initialLoadError = null,
  inventoryValue,
  vouchersValue = 0,
  statusFilter = "owned",
  canDeleteInventory = false,
}: {
  userId: string;
  initialInventory: PaginatedInventory;
  /**
   * Error string from the server-side safeQuery that produced
   * `initialInventory` (null on success). When set, the seeded page is the
   * empty fallback — render a VISIBLE error instead of "No items in
   * inventory" so a failed scan can't masquerade as an empty stash.
   */
  initialLoadError?: string | null;
  inventoryValue: number;
  /** Unclaimed voucher value the user is holding. Shown next to the
   *  card value so "Current Inventory" reflects all held value — a
   *  voucher is held value just like a card. */
  vouchersValue?: number;
  statusFilter?: string;
  /** Same gate as Adjust Balance — admin or __can_adjust_balance. */
  canDeleteInventory?: boolean;
}) {
  const [inventory, setInventory] = useState(initialInventory);
  const [loadError, setLoadError] = useState<string | null>(
    initialLoadError ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InventoryItem | null>(null);
  // Multi-select for bulk removal. Holds inventory-item ids + their values
  // (value kept so the bulk dialog can show a total without a re-fetch).
  // Persists across pages so an admin can sweep a large inventory.
  const [selected, setSelected] = useState<Map<string, number>>(new Map());
  const [bulkOpen, setBulkOpen] = useState(false);
  const canSelect = canDeleteInventory && statusFilter === "owned";

  const toggleSelect = (item: InventoryItem) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item.value);
      return next;
    });
  };
  const clearSelection = () => setSelected(new Map());
  const selectedValue = [...selected.values()].reduce((a, b) => a + b, 0);
  const [rarity, setRarity] = useState("all");
  const [sort, setSort] = useState("newest");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [page, setPage] = useState(1);

  const { data, totalPages, total } = inventory;

  const hasFilters =
    rarity !== "all" ||
    sort !== "newest" ||
    search !== "" ||
    priceMin !== "" ||
    priceMax !== "";

  // The parent /users/[id] page re-renders every 60s via AutoRefresh and
  // hands a fresh `initialInventory`. Re-seed ONLY when the admin hasn't
  // touched filters/sort/search/pagination — the old unguarded
  // `setInventory(initialInventory)` snapped every filter + page back to
  // defaults on each tick, yanking the admin's view mid-investigation
  // (the "filters snap back every 60s" bug). Exact guard pattern from
  // CategoryTransactionsTable; page size here is fixed at 24 so no
  // perPage-respecting refetch branch is needed.
  useEffect(() => {
    if (hasFilters || page !== 1) return;
    setInventory(initialInventory);
    setLoadError(initialLoadError ?? null);
    // Depend ONLY on `initialInventory` — re-seed on a NEW server payload,
    // not when the admin toggles a filter back (those run their own
    // explicit load(...) calls).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialInventory]);

  const load = async (overrides: Record<string, unknown> = {}) => {
    const p = (overrides.page as number) ?? page;
    const filters = {
      rarity:
        ((overrides.rarity as string) ?? rarity) !== "all"
          ? ((overrides.rarity as string) ?? rarity)
          : undefined,
      status: statusFilter,
      search: ((overrides.search as string) ?? search) || undefined,
      sort:
        ((overrides.sort as string) ?? sort) !== "newest"
          ? ((overrides.sort as string) ?? sort)
          : undefined,
      priceMin:
        ((overrides.priceMin as string) ?? priceMin)
          ? Number((overrides.priceMin as string) ?? priceMin)
          : undefined,
      priceMax:
        ((overrides.priceMax as string) ?? priceMax)
          ? Number((overrides.priceMax as string) ?? priceMax)
          : undefined,
    };
    setLoading(true);
    try {
      const result = await fetchInventory(userId, p, 24, filters);
      setInventory(result);
      setLoadError(null);
    } catch {
      // Don't let a rejected fetch bubble out of the handler — keep the
      // previous grid on screen and surface a toast (a thrown action here
      // used to escalate to the segment error boundary = whole page gone).
      toast.error("Couldn't load inventory — try again");
    } finally {
      setLoading(false);
    }
  };

  const updateFilter = (key: string, value: string | null) => {
    const v = value ?? "";
    const updates: Record<string, unknown> = { [key]: v, page: 1 };
    if (key === "rarity") setRarity(v);
    else if (key === "sort") setSort(v);
    else if (key === "search") setSearch(v);
    else if (key === "priceMin") setPriceMin(v);
    else if (key === "priceMax") setPriceMax(v);
    setPage(1);
    load(updates);
  };

  const navigate = (newPage: number) => {
    setPage(newPage);
    load({ page: newPage });
  };

  const clearFilters = () => {
    setRarity("all");

    setSort("newest");
    setSearch("");
    setSearchInput("");
    setPriceMin("");
    setPriceMax("");
    setPage(1);
    load({
      rarity: "all",
      sort: "newest",
      search: "",
      priceMin: "",
      priceMax: "",
      page: 1,
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {total} items
            {inventoryValue > 0 ? (
              <>
                {" "}
                —{" "}
                <span className="text-muted-foreground">
                  {formatCurrency(inventoryValue)}
                </span>
              </>
            ) : null}
            {vouchersValue > 0 ? (
              <>
                {" "}
                <span className="text-muted-foreground">
                  + {formatCurrency(vouchersValue)} in vouchers
                </span>
              </>
            ) : null}
          </CardTitle>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => navigate(1)}
                disabled={page <= 1 || loading}
              >
                <ChevronsLeft className="size-3" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => navigate(page - 1)}
                disabled={page <= 1 || loading}
              >
                <ChevronLeft className="size-3" />
              </Button>
              <span className="px-2 text-xs text-muted-foreground">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => navigate(page + 1)}
                disabled={page >= totalPages || loading}
              >
                <ChevronRight className="size-3" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => navigate(totalPages)}
                disabled={page >= totalPages || loading}
              >
                <ChevronsRight className="size-3" />
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2 pt-2">
          <div className="relative flex-1 min-w-[140px] sm:max-w-[220px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Search cards..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") updateFilter("search", searchInput);
              }}
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Select
            value={rarity}
            onValueChange={(v) => updateFilter("rarity", v)}
          >
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue placeholder="Rarity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All rarities</SelectItem>
              <SelectItem value="common">Common</SelectItem>
              <SelectItem value="uncommon">Uncommon</SelectItem>
              <SelectItem value="rare">Rare</SelectItem>
              <SelectItem value="ultra rare">Ultra Rare</SelectItem>
              <SelectItem value="legendary">Legendary</SelectItem>
              <SelectItem value="secret">Secret</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => updateFilter("sort", v)}>
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="oldest">Oldest</SelectItem>
              <SelectItem value="price_desc">Price High</SelectItem>
              <SelectItem value="price_asc">Price Low</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              placeholder="Min $"
              value={priceMin}
              onChange={(e) => updateFilter("priceMin", e.target.value)}
              className="h-8 w-[80px] sm:w-[90px] text-xs"
            />
            <span className="text-xs text-muted-foreground">-</span>
            <Input
              type="number"
              placeholder="Max $"
              value={priceMax}
              onChange={(e) => updateFilter("priceMax", e.target.value)}
              className="h-8 w-[80px] sm:w-[90px] text-xs"
            />
          </div>
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs px-2"
              onClick={clearFilters}
            >
              <X className="size-3 mr-1" />
              Clear
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="relative">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 rounded-b-lg">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {canSelect && selected.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
            <span className="text-sm font-medium">
              {selected.size} selected
              <span className="ml-1 text-muted-foreground tabular-nums">
                ({formatCurrency(selectedValue)})
              </span>
            </span>
            <Button
              variant="destructive"
              size="sm"
              className="h-7 gap-1.5"
              onClick={() => setBulkOpen(true)}
            >
              <Trash2 className="size-3" />
              Remove selected
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={clearSelection}
            >
              Clear
            </Button>
          </div>
        )}
        {(() => {
          const renderCard = (item: InventoryItem) => (
            <div
              key={item.id}
              className="group relative rounded-lg border bg-card overflow-hidden transition-shadow hover:shadow-md"
            >
              {canSelect && (
                <span
                  className="absolute left-1 top-1 z-10 rounded bg-background/80 p-0.5 backdrop-blur-sm"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    checked={selected.has(item.id)}
                    onCheckedChange={() => toggleSelect(item)}
                    aria-label={`Select ${item.cardName}`}
                  />
                </span>
              )}
              {canDeleteInventory && statusFilter === "owned" && (
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute right-1 top-1 z-10 size-7 opacity-90 hover:opacity-100 transition-opacity"
                  aria-label={`Remove ${item.cardName} from inventory`}
                  onClick={() => setDeleteTarget(item)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
              <div className="aspect-[2/3] relative bg-muted">
                <CardImage
                  src={item.imageUrl}
                  alt={item.cardName}
                  className="size-full rounded-t-lg"
                />
                {item.rarity && (
                  <span
                    className={`absolute bottom-1 left-1 rounded px-1 py-0.5 text-[10px] font-semibold leading-none shadow backdrop-blur-sm ${INVENTORY_RARITY_COLORS[item.rarity.toLowerCase()] ?? "bg-black/80 text-white"}`}
                  >
                    {item.rarity}
                  </span>
                )}
              </div>
              <div className="p-1 space-y-0">
                <p
                  className="text-[10px] font-medium truncate"
                  title={item.cardName}
                >
                  {item.cardName}
                </p>
                <p className="text-xs font-medium text-muted-foreground">
                  {formatCurrency(item.value)}
                </p>
                {/* Provenance badge — where this card came from. `reward` =
                    granted by a reward / sign-up / daily pack (full per-pack
                    trail on the Rewards tab); tinted purple to stand out from
                    bought/won cards. */}
                <span
                  className={cn(
                    "mt-0.5 inline-block max-w-full truncate rounded px-1 py-0 text-[9px] font-medium leading-tight",
                    item.sourceType === "reward"
                      ? "bg-purple-500/15 text-purple-600 dark:text-purple-400"
                      : "bg-muted text-muted-foreground",
                  )}
                  title={`Source: ${inventorySourceLabel(item.sourceType)}`}
                >
                  {inventorySourceLabel(item.sourceType)}
                </span>
              </div>
            </div>
          );

          const gridClass =
            "grid grid-cols-3 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-1.5";

          return (
            <>
              {data.length > 0 ? (
                <div className={gridClass}>{data.map(renderCard)}</div>
              ) : loadError ? (
                // Failed/timed-out inventory query — visible error, never
                // the "No items" empty state (error ≠ empty).
                <InlineError
                  compact
                  title="Couldn't load inventory"
                  hint="This is a load failure, not an empty inventory — retry to re-run the query."
                />
              ) : (
                <EmptyState
                  icon={Gem}
                  title={
                    hasFilters ? "No items match your filters" : "No items in inventory"
                  }
                  description={
                    hasFilters
                      ? "Try clearing or adjusting the filters above."
                      : "This user is not holding any cards right now."
                  }
                  compact
                />
              )}
            </>
          );
        })()}
        {deleteTarget && (
          <InventoryItemDeleteDialog
            userId={userId}
            item={deleteTarget}
            open={Boolean(deleteTarget)}
            onOpenChange={(open) => {
              if (!open) setDeleteTarget(null);
            }}
            onDeleted={() => load({ page })}
          />
        )}
        {canSelect && (
          <InventoryBulkDeleteDialog
            userId={userId}
            itemIds={[...selected.keys()]}
            totalValue={selectedValue}
            open={bulkOpen}
            onOpenChange={setBulkOpen}
            onDeleted={() => {
              clearSelection();
              load({ page });
            }}
          />
        )}
      </CardContent>
    </Card>
  );
});

/* ── Disposed Cards Table (Sold + Exchanged, merged) ── */

export const DisposedCardsTable = React.memo(function DisposedCardsTable({
  userId,
  initialInventory,
  initialLoadError = null,
}: {
  userId: string;
  initialInventory: PaginatedInventory;
  /** Same contract as InventoryGrid.initialLoadError — error ≠ empty. */
  initialLoadError?: string | null;
}) {
  const [inventory, setInventory] = useState(initialInventory);
  const [loadError, setLoadError] = useState<string | null>(
    initialLoadError ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"disposed" | "sold" | "exchanged">("disposed");
  const [rarity, setRarity] = useState("all");
  const [sort, setSort] = useState("newest");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { data, totalPages, total } = inventory;

  const hasFilters =
    rarity !== "all" ||
    sort !== "newest" ||
    search !== "" ||
    statusFilter !== "disposed";

  // Same guarded AutoRefresh re-seed as InventoryGrid. This table
  // previously had NO re-seed at all, so after the first 60s tick it was
  // permanently stale (new disposals never appeared without a manual
  // status/filter toggle). Pristine view (default status tab, no filters,
  // page 1) → adopt the fresh server payload; any admin-driven state →
  // leave it alone.
  useEffect(() => {
    if (hasFilters || page !== 1) return;
    setInventory(initialInventory);
    setLoadError(initialLoadError ?? null);
    // Depend ONLY on `initialInventory` — re-seed on a NEW server payload,
    // not on local filter toggles (those run their own load(...) calls).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialInventory]);

  const load = async (overrides: Record<string, unknown> = {}) => {
    const p = (overrides.page as number) ?? page;
    const filters = {
      status: (overrides.status as string) ?? statusFilter,
      rarity:
        ((overrides.rarity as string) ?? rarity) !== "all"
          ? ((overrides.rarity as string) ?? rarity)
          : undefined,
      search: ((overrides.search as string) ?? search) || undefined,
      sort:
        ((overrides.sort as string) ?? sort) !== "newest"
          ? ((overrides.sort as string) ?? sort)
          : undefined,
    };
    setLoading(true);
    try {
      const result = await fetchInventory(userId, p, 24, filters);
      setInventory(result);
      setLoadError(null);
    } catch {
      // Keep previous rows + toast — same no-page-nuke contract as
      // InventoryGrid / CategoryTransactionsTable.
      toast.error("Couldn't load sold & exchanged cards — try again");
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = (v: "disposed" | "sold" | "exchanged") => {
    setStatusFilter(v);
    setPage(1);
    load({ status: v, page: 1 });
  };

  const clearFilters = () => {
    setRarity("all");
    setSort("newest");
    setSearch("");
    setSearchInput("");
    setStatusFilter("disposed");
    setPage(1);
    load({ status: "disposed", rarity: "all", sort: "newest", search: "", page: 1 });
  };

  const navigate = (newPage: number) => {
    setPage(newPage);
    load({ page: newPage });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Status tabs */}
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {(["disposed", "sold", "exchanged"] as const).map((s) => (
              <button
                key={s}
                onClick={() => updateStatus(s)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors",
                  statusFilter === s
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s === "disposed" ? "All" : s}
              </button>
            ))}
          </div>

          <span className="text-xs text-muted-foreground">{total} items</span>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative w-[180px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Search cards..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setSearch(searchInput);
                    setPage(1);
                    load({ search: searchInput, page: 1 });
                  }
                }}
                className="h-8 pl-7 text-xs"
              />
            </div>
            <Select
              value={rarity}
              onValueChange={(v) => {
                if (!v) return;
                setRarity(v);
                setPage(1);
                load({ rarity: v, page: 1 });
              }}
            >
              <SelectTrigger className="h-8 w-[110px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All rarities</SelectItem>
                <SelectItem value="common">Common</SelectItem>
                <SelectItem value="uncommon">Uncommon</SelectItem>
                <SelectItem value="rare">Rare</SelectItem>
                <SelectItem value="ultra rare">Ultra Rare</SelectItem>
                <SelectItem value="legendary">Legendary</SelectItem>
                <SelectItem value="secret">Secret</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={sort}
              onValueChange={(v) => {
                if (!v) return;
                setSort(v);
                setPage(1);
                load({ sort: v, page: 1 });
              }}
            >
              <SelectTrigger className="h-8 w-[110px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest</SelectItem>
                <SelectItem value="oldest">Oldest</SelectItem>
                <SelectItem value="price_desc">Value high</SelectItem>
                <SelectItem value="price_asc">Value low</SelectItem>
              </SelectContent>
            </Select>
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs px-2"
                onClick={clearFilters}
              >
                <X className="size-3 mr-1" />
                Clear
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="relative p-0">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {data.length > 0 ? (
          <div className="divide-y">
            {data.map((item) => {
              const status: "sold" | "exchanged" = item.soldAt ? "sold" : "exchanged";
              const disposedAt = item.soldAt ?? item.exchangedAt;
              return (
                <div
                  key={item.id}
                  className="flex items-center gap-3 px-4 py-2 hover:bg-muted/40 transition-colors"
                >
                  <div className="size-10 shrink-0 overflow-hidden rounded bg-muted">
                    <CardImage
                      src={item.imageUrl}
                      alt={item.cardName}
                      className="size-full"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.cardName}</p>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      {item.rarity && (
                        <span
                          className={cn(
                            "rounded px-1 py-0 text-[10px] font-semibold uppercase",
                            INVENTORY_RARITY_COLORS[item.rarity.toLowerCase()] ??
                              "bg-muted text-foreground",
                          )}
                        >
                          {item.rarity}
                        </span>
                      )}
                      <span
                        className={cn(
                          "rounded px-1 py-0 text-[10px] font-medium",
                          item.sourceType === "reward"
                            ? "bg-purple-500/15 text-purple-600 dark:text-purple-400"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {inventorySourceLabel(item.sourceType)}
                      </span>
                      <span>·</span>
                      <span>obtained {formatRelative(item.obtainedAt)}</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 shrink-0">
                    <span className="text-sm font-medium tabular-nums">
                      {formatCurrency(item.value)}
                    </span>
                    <span
                      className={cn(
                        "text-[10px] font-semibold uppercase rounded px-1.5 py-0",
                        status === "sold"
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          : "bg-blue-500/15 text-blue-600 dark:text-blue-400",
                      )}
                    >
                      {status}
                    </span>
                  </div>
                  <div className="ml-2 w-[120px] shrink-0 text-right text-xs text-muted-foreground">
                    {disposedAt ? formatRelative(disposedAt) : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        ) : loadError ? (
          <InlineError
            compact
            title="Couldn't load sold & exchanged cards"
            hint="This is a load failure, not an empty history — retry to re-run the query."
          />
        ) : (
          <EmptyState
            icon={Package}
            title={
              hasFilters ? "No items match your filters" : "No sold or exchanged cards"
            }
            description={
              hasFilters
                ? "Try clearing or adjusting the filters above."
                : "This user has not sold or exchanged any cards yet."
            }
            compact
          />
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-2">
            <span className="text-xs text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => navigate(1)}
                disabled={page === 1}
              >
                <ChevronsLeft className="size-3.5" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => navigate(page - 1)}
                disabled={page === 1}
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => navigate(page + 1)}
                disabled={page === totalPages}
              >
                <ChevronRight className="size-3.5" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => navigate(totalPages)}
                disabled={page === totalPages}
              >
                <ChevronsRight className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
});
