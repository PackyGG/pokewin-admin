"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Check, Loader2, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
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
import { Badge } from "@/components/ui/badge";
import { CardImage } from "@/components/card-image";
import { formatCurrency } from "@/lib/utils/format";
import { searchBuilderCards, type BuilderCardItem } from "./actions";
import { RARITY_BADGE_COLORS } from "@/app/(admin)/transactions/_shared/rarity-colors";

/**
 * Pack-Studio Builder card picker. Modeled 1:1 on the `/packs`
 * <CardPickerDialog>, but driven by the Pack-Studio-gated `searchBuilderCards`
 * action and surfacing each card's VALUE + `inPacks` usage + a one-line
 * liability hint so the operator can weigh reuse/exposure before adding a card.
 *
 * House-POV note: a card's VALUE is what the house owes if it drops — a high
 * value relative to the pack price is a liability for the house, hence the
 * amber/rose hint tinting (never green for a big-value card).
 */


/**
 * Liability hint for a single card relative to the current pack price (House POV).
 *   - value ≥ 5×price  → "grail" jackpot exposure (rose).
 *   - value ≥ price    → a winning card (amber).
 *   - else             → low exposure (muted).
 * When no price is set yet we fall back to a neutral note.
 */
/**
 * Format a numeric range bound for the Min/Max price inputs. The picker's
 * `<Input type="number">` accepts a string; we want a clean "5" / "1.25" /
 * "0.50" with no trailing zeros for integers, two decimals for fractional
 * values. `0` becomes an empty string so the lower bound of a "0 – $0.50"
 * suggestion doesn't force the user to clear it before searching.
 */
function formatRangeValue(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function liabilityHint(value: number, price: number): { label: string; className: string } {
  if (!(price > 0)) {
    return { label: "set a price to gauge exposure", className: "text-muted-foreground" };
  }
  const mult = value / price;
  if (value >= 5 * price) {
    return {
      label: `grail · ${mult.toFixed(1)}× price exposure`,
      className: "text-rose-600 dark:text-rose-400",
    };
  }
  if (value >= price) {
    return {
      label: `win card · ${mult.toFixed(1)}× price`,
      className: "text-amber-600 dark:text-amber-400",
    };
  }
  return {
    label: `${(mult * 100).toFixed(0)}% of price`,
    className: "text-muted-foreground",
  };
}

export function BuilderCardPicker({
  selectedIds,
  onSelect,
  sets,
  rarities,
  price,
  open: openProp,
  onOpenChange,
  initialPriceMin,
  initialPriceMax,
}: {
  selectedIds: string[];
  onSelect: (card: BuilderCardItem) => void;
  sets: { id: string; name: string }[];
  rarities: string[];
  /** Current pack price — drives the per-card liability hint. */
  price: number;
  /**
   * Optional controlled-open mode. When `open` is provided, the picker becomes
   * a controlled `Dialog`: the parent owns the open state and is notified via
   * `onOpenChange`. Used by the retune review's "Add a card in $X–$Y range"
   * button, which opens the picker programmatically. When omitted, the picker
   * stays uncontrolled and uses its own internal open state (the historical
   * behavior).
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Optional seed values for the Min/Max price filter. When provided, the
   * filter inputs start pre-filled with this range so the operator can act on a
   * "suggested range" without re-typing the bounds. Re-applied every time the
   * dialog opens (so opening it again with a NEW range resets the filter).
   */
  initialPriceMin?: number;
  initialPriceMax?: number;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );
  const [isPending, startTransition] = useTransition();

  const [search, setSearch] = useState("");
  const [rarity, setRarity] = useState("all");
  const [setId, setSetId] = useState("all");
  const [minPrice, setMinPrice] = useState(
    initialPriceMin !== undefined ? formatRangeValue(initialPriceMin) : "",
  );
  const [maxPrice, setMaxPrice] = useState(
    initialPriceMax !== undefined ? formatRangeValue(initialPriceMax) : "",
  );
  const [page, setPage] = useState(1);
  const perPage = 40;

  // Re-apply the suggested range every time the dialog opens. Owner workflow:
  // close → click a different "+ Add a card in $A–$B" button → re-open. Each
  // open should reflect the LATEST suggestion, not the previous filter state.
  useEffect(() => {
    if (!open) return;
    if (initialPriceMin !== undefined) setMinPrice(formatRangeValue(initialPriceMin));
    if (initialPriceMax !== undefined) setMaxPrice(formatRangeValue(initialPriceMax));
  }, [open, initialPriceMin, initialPriceMax]);

  const [cards, setCards] = useState<BuilderCardItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const requestIdRef = useRef(0);

  const fetchCards = useCallback(
    (p: number) => {
      const reqId = ++requestIdRef.current;
      startTransition(async () => {
        const result = await searchBuilderCards({
          page: p,
          perPage,
          search: search || undefined,
          rarity: rarity !== "all" ? rarity : undefined,
          setId: setId !== "all" ? setId : undefined,
          minPrice: minPrice || undefined,
          maxPrice: maxPrice || undefined,
        });
        if (reqId !== requestIdRef.current) return;
        setCards(result.data);
        setTotal(result.total);
        setTotalPages(result.totalPages);
      });
    },
    [search, rarity, setId, minPrice, maxPrice, perPage],
  );

  // Fetch on open and when filters change.
  useEffect(() => {
    if (!open) return;
    setPage(1);
    fetchCards(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, search, rarity, setId, minPrice, maxPrice]);

  function goToPage(p: number) {
    setPage(p);
    fetchCards(p);
  }

  function handleSearchChange(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(value), 300);
  }

  const selectedCount = selectedIds.length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            className="h-9 w-full justify-between text-left font-normal"
          />
        }
      >
        <span className="text-muted-foreground">
          Add cards...
          {selectedCount > 0 && (
            <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
              {selectedCount} added
            </span>
          )}
        </span>
        <Plus className="ml-1 size-3 shrink-0 opacity-50" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Add Cards</DialogTitle>
        </DialogHeader>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            {isPending ? (
              <Loader2 className="absolute left-2.5 top-2.5 size-4 text-muted-foreground animate-spin" />
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
          <Select value={rarity} onValueChange={(v) => v && setRarity(v)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
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
          <Select value={setId} onValueChange={(v) => v && setSetId(v)}>
            <SelectTrigger className="w-[180px]">
              <span className="truncate">
                {setId === "all"
                  ? "All Sets"
                  : sets.find((s) => s.id === setId)?.name ?? "All Sets"}
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
        </div>

        {/* Card grid */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {cards.length === 0 && !isPending ? (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              No cards found.
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-3 py-2">
              {cards.map((card) => {
                const isSelected = selectedIds.includes(card.id);
                const hint = liabilityHint(card.priceUsd, price);
                return (
                  <button
                    key={card.id}
                    type="button"
                    disabled={isSelected}
                    onClick={() => onSelect(card)}
                    className={`group relative text-left rounded-lg border p-2 transition-colors ${
                      isSelected
                        ? "border-primary/50 bg-primary/5 opacity-60 cursor-default"
                        : "border-transparent hover:border-primary/30 hover:bg-accent cursor-pointer"
                    }`}
                  >
                    {isSelected && (
                      <div className="absolute top-1.5 right-1.5 z-10 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check className="size-3" />
                      </div>
                    )}
                    <CardImage src={card.imageUrl} alt={card.name} className="w-full rounded" />
                    <div className="mt-1.5">
                      <p className="text-xs font-medium truncate">{card.name}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        {card.rarity && (
                          <Badge
                            variant="outline"
                            className={`text-[9px] px-1 py-0 ${RARITY_BADGE_COLORS[card.rarity.toLowerCase()] ?? ""}`}
                          >
                            {card.rarity}
                          </Badge>
                        )}
                        <span className="text-[10px] font-medium tabular-nums">
                          {formatCurrency(card.priceUsd)}
                        </span>
                      </div>
                      <p className={`mt-0.5 truncate text-[10px] ${hint.className}`}>
                        {hint.label}
                      </p>
                      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                        {card.inPacks === 0
                          ? "unused"
                          : `in ${card.inPacks} pack${card.inPacks === 1 ? "" : "s"}`}
                      </p>
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
              <span className="text-xs text-muted-foreground px-2">
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
      </DialogContent>
    </Dialog>
  );
}
