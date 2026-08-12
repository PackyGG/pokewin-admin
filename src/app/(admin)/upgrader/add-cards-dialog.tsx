"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CardImage } from "@/components/card-image";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { transition } from "@/components/ux";

import {
  addUpgraderOutputs,
  getUpgraderPickerFilters,
  searchCardsForUpgraderPicker,
  type UpgraderCardPickerItem,
  type UpgraderPickerFilters,
} from "./actions";
import { RARITY_BADGE_COLORS } from "../transactions/_shared/rarity-colors";

// Sort options for the picker grid. The value encodes both field and
// direction so the Select holds a single string; we split it back into
// the action's { sortBy, sortOrder } pair at the fetch boundary.
type SortOption = "price_desc" | "price_asc" | "name_asc";

const SORT_PARAMS: Record<
  SortOption,
  { sortBy: "name" | "price"; sortOrder: "asc" | "desc" }
> = {
  price_desc: { sortBy: "price", sortOrder: "desc" },
  price_asc: { sortBy: "price", sortOrder: "asc" },
  name_asc: { sortBy: "name", sortOrder: "asc" },
};

const SORT_LABELS: Record<SortOption, string> = {
  price_desc: "Price: High → Low",
  price_asc: "Price: Low → High",
  name_asc: "Name: A → Z",
};


export function AddUpgraderCardsDialog({
  existingCardIds,
}: {
  existingCardIds: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [isSubmitting, startSubmitting] = useTransition();

  // Set + rarity dropdown options, loaded on FIRST OPEN instead of on every
  // catalog paint. They only feed this (closed-by-default) dialog, so fetching
  // them with the Catalog segment cost two MAIN reads per render for a hidden
  // component — see `getUpgraderPickerFilters`. Cached server-side, so the
  // request is a single round trip and reopening never refetches.
  const [filters, setFilters] = useState<UpgraderPickerFilters | null>(null);
  const filtersRequestedRef = useRef(false);
  useEffect(() => {
    if (!open || filtersRequestedRef.current) return;
    filtersRequestedRef.current = true;
    getUpgraderPickerFilters()
      .then(setFilters)
      .catch(() => {
        // Degrade to "All …" only, and allow a retry on the next open. The
        // card grid below has its own fetch and is unaffected.
        filtersRequestedRef.current = false;
        setFilters({ sets: [], rarities: [] });
      });
  }, [open]);
  const sets = filters?.sets ?? [];
  const rarities = filters?.rarities ?? [];
  const filtersLoading = open && filters === null;

  const [search, setSearch] = useState("");
  const [rarity, setRarity] = useState("all");
  const [setId, setSetId] = useState("all");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [sort, setSort] = useState<SortOption>("price_desc");
  const [page, setPage] = useState(1);
  const perPage = 40;

  const [cards, setCards] = useState<UpgraderCardPickerItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const fetchCards = useCallback(
    (p: number) => {
      startTransition(async () => {
        const result = await searchCardsForUpgraderPicker({
          page: p,
          perPage,
          search: search || undefined,
          rarity: rarity !== "all" ? rarity : undefined,
          setId: setId !== "all" ? setId : undefined,
          minPrice: minPrice || undefined,
          maxPrice: maxPrice || undefined,
          ...SORT_PARAMS[sort],
        });
        setCards(result.data);
        setTotal(result.total);
        setTotalPages(result.totalPages);
      });
    },
    [search, rarity, setId, minPrice, maxPrice, sort],
  );

  useEffect(() => {
    if (!open) return;
    setPage(1);
    fetchCards(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, search, rarity, setId, minPrice, maxPrice, sort]);

  // Reset selection whenever the dialog closes so reopening starts fresh.
  useEffect(() => {
    if (!open) setSelectedIds(new Set());
  }, [open]);

  function goToPage(p: number) {
    setPage(p);
    fetchCards(p);
  }

  function handleSearchChange(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(value), 300);
  }

  function toggleCard(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSubmit() {
    if (selectedIds.size === 0) return;
    startSubmitting(async () => {
      try {
        const result = await addUpgraderOutputs(Array.from(selectedIds));
        const parts: string[] = [];
        if (result.inserted > 0) parts.push(`${result.inserted} added`);
        if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
        toast.success(parts.length > 0 ? parts.join(", ") : "Pool updated");
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to add cards");
      }
    });
  }

  const existing = new Set(existingCardIds);
  const selectedCount = selectedIds.size;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="gap-2" />}>
        <Plus className="size-4" />
        Add Cards
      </DialogTrigger>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Add Cards to Upgrader Pool</DialogTitle>
        </DialogHeader>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            {isPending ? (
              <Loader2 className="absolute left-2.5 top-2.5 size-4 animate-spin text-muted-foreground" />
            ) : (
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            )}
            <Input
              placeholder="Search by name..."
              defaultValue=""
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-8"
            />
          </div>
          {/* Both option lists arrive on first open (see `filters` above), so
              they are disabled while in flight — an enabled dropdown holding
              only "All" would read as "this catalog has no rarities/sets". */}
          <Select
            value={rarity}
            onValueChange={(v) => v && setRarity(v)}
            disabled={filtersLoading}
          >
            <SelectTrigger className="w-[140px]">
              <span className="truncate">
                {filtersLoading
                  ? "Loading…"
                  : rarity === "all"
                    ? "All Rarities"
                    : rarity}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Rarities</SelectItem>
              {rarities.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={setId}
            onValueChange={(v) => v && setSetId(v)}
            disabled={filtersLoading}
          >
            <SelectTrigger className="w-[180px]">
              <span className="truncate">
                {filtersLoading
                  ? "Loading…"
                  : setId === "all"
                    ? "All Sets"
                    : (sets.find((s) => s.id === setId)?.name ?? "All Sets")}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sets</SelectItem>
              {sets.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              placeholder="Min $"
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
              className="w-[80px]"
              min="0"
              step="0.01"
            />
            <span className="text-xs text-muted-foreground">-</span>
            <Input
              type="number"
              placeholder="Max $"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              className="w-[80px]"
              min="0"
              step="0.01"
            />
          </div>
          <Select
            value={sort}
            onValueChange={(v) => v && setSort(v as SortOption)}
          >
            <SelectTrigger className="w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as SortOption[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {SORT_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Grid */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* First load (no cards yet, request in flight) → skeleton
              tiles matching the picker grid so the dialog opens onto a
              populated-looking surface instead of a blank gap that pops
              when results land. */}
          {cards.length === 0 && isPending ? (
            <div
              className="grid grid-cols-3 gap-3 py-2 sm:grid-cols-4 lg:grid-cols-5"
              aria-hidden
            >
              {Array.from({ length: 10 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-transparent p-2"
                >
                  <Skeleton className="w-full rounded" style={{ aspectRatio: "3 / 4" }} />
                  <div className="mt-1.5 space-y-1">
                    <Skeleton className="h-3 w-3/4 rounded" />
                    <Skeleton className="h-2.5 w-1/2 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : cards.length === 0 && !isPending ? (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              No cards found.
            </div>
          ) : (
            // On a filter/page change we keep the previous results
            // mounted and only dim them while the next page streams in —
            // a soft refresh reads as "updating", not "cleared". Pointer
            // events stay live so the user can keep interacting.
            <div
              className={cn(
                "grid grid-cols-3 gap-3 py-2 sm:grid-cols-4 lg:grid-cols-5",
                transition("opacity", "fast"),
                isPending && "opacity-50",
              )}
            >
              {cards.map((card) => {
                const alreadyInPool = existing.has(card.id);
                const isSelected = selectedIds.has(card.id);
                const disabled = alreadyInPool;
                return (
                  <button
                    key={card.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => toggleCard(card.id)}
                    className={`group relative rounded-lg border p-2 text-left transition-colors ${
                      disabled
                        ? "cursor-not-allowed border-muted-foreground/20 bg-muted/20 opacity-50"
                        : isSelected
                          ? "cursor-pointer border-primary bg-primary/10"
                          : "cursor-pointer border-transparent hover:border-primary/30 hover:bg-accent"
                    }`}
                  >
                    {(isSelected || alreadyInPool) && (
                      <div
                        className={`absolute right-1.5 top-1.5 z-10 flex size-5 items-center justify-center rounded-full ${
                          alreadyInPool
                            ? "bg-muted-foreground text-background"
                            : "bg-primary text-primary-foreground"
                        }`}
                        title={alreadyInPool ? "Already in pool" : "Selected"}
                      >
                        <Check className="size-3" />
                      </div>
                    )}
                    <CardImage
                      src={card.imageUrl}
                      alt={card.name}
                      className="w-full rounded"
                    />
                    <div className="mt-1.5">
                      <p className="truncate text-xs font-medium">
                        {card.name}
                      </p>
                      <div className="mt-0.5 flex items-center gap-1">
                        {card.rarity && (
                          <Badge
                            variant="outline"
                            className={`px-1 py-0 text-[9px] ${RARITY_BADGE_COLORS[card.rarity.toLowerCase()] ?? ""}`}
                          >
                            {card.rarity}
                          </Badge>
                        )}
                        <span className="text-[10px] text-muted-foreground">
                          {formatCurrency(card.priceUsd)}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t pt-3">
            <p className="text-xs text-muted-foreground">
              {total} card{total !== 1 ? "s" : ""} found
            </p>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={page <= 1}
                onClick={() => goToPage(page - 1)}
              >
                Previous
              </Button>
              <span className="px-2 text-xs text-muted-foreground">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={page >= totalPages}
                onClick={() => goToPage(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}

        <DialogFooter className="border-t pt-3">
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {selectedCount === 0
                ? "No cards selected"
                : `${selectedCount} card${selectedCount !== 1 ? "s" : ""} selected`}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={selectedCount === 0 || isSubmitting}
              >
                {isSubmitting
                  ? "Adding..."
                  : selectedCount === 0
                    ? "Add to Pool"
                    : `Add ${selectedCount} to Pool`}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
