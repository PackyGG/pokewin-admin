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
import { searchCardsForPicker, type CardPickerItem } from "./actions";

const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  uncommon: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  rare: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  "ultra rare": "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  secret: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
};

export function CardPickerDialog({
  selectedIds,
  onSelect,
  sets,
  rarities,
}: {
  selectedIds: string[];
  onSelect: (card: CardPickerItem) => void;
  sets: { id: string; name: string }[];
  rarities: string[];
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const [search, setSearch] = useState("");
  const [rarity, setRarity] = useState("all");
  const [setId, setSetId] = useState("all");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [page, setPage] = useState(1);
  const perPage = 40;

  const [cards, setCards] = useState<CardPickerItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const fetchCards = useCallback(
    (p: number) => {
      startTransition(async () => {
        const result = await searchCardsForPicker({
          page: p,
          perPage,
          search: search || undefined,
          rarity: rarity !== "all" ? rarity : undefined,
          setId: setId !== "all" ? setId : undefined,
          minPrice: minPrice || undefined,
          maxPrice: maxPrice || undefined,
        });
        setCards(result.data);
        setTotal(result.total);
        setTotalPages(result.totalPages);
      });
    },
    [search, rarity, setId, minPrice, maxPrice, perPage],
  );

  // Fetch on open and when filters change
  useEffect(() => {
    if (!open) return;
    setPage(1);
    fetchCards(1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, search, rarity, setId, minPrice, maxPrice]);

  // Fetch on page change (but not on filter change — that resets to page 1)
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
          <Button variant="outline" className="h-9 w-full justify-between text-left font-normal" />
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
      <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col">
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
                {setId === "all" ? "All Sets" : sets.find((s) => s.id === setId)?.name ?? "All Sets"}
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
                    <CardImage
                      src={card.imageUrl}
                      alt={card.name}
                      className="w-full rounded"
                    />
                    <div className="mt-1.5">
                      <p className="text-xs font-medium truncate">{card.name}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        {card.rarity && (
                          <Badge
                            variant="outline"
                            className={`text-[9px] px-1 py-0 ${RARITY_COLORS[card.rarity.toLowerCase()] ?? ""}`}
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
