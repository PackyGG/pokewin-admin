"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Gamepad2,
  Layers,
  LayoutGrid,
  Rows3,
  Search,
  X,
} from "lucide-react";
import { CardImage } from "@/components/card-image";
import {
  CardTile,
  getRarityDot,
  getRarityRing,
} from "@/components/card-tile";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { toast } from "sonner";
import { fetchPackGames } from "../actions";

// Legacy rarity palette — still used by the games-table rows (not the
// pack-card grid, which now delegates to <CardTile />).
const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-700/90 text-zinc-100",
  uncommon: "bg-emerald-700/90 text-emerald-100",
  rare: "bg-blue-700/90 text-blue-100",
  "ultra rare": "bg-purple-700/90 text-purple-100",
  "secret rare": "bg-yellow-600/90 text-yellow-100",
  legendary: "bg-orange-600/90 text-orange-100",
  holo: "bg-cyan-700/90 text-cyan-100",
  secret: "bg-pink-700/90 text-pink-100",
};

type GameItem = {
  id: string;
  userId: string | null;
  username: string | null;
  email: string | null;
  type: "solo" | "battle";
  isBorrowed: boolean;
  isSponsored: boolean;
  cardName: string | null;
  cardImageUrl: string | null;
  cardRarity: string | null;
  cardPrice: number;
  createdAt: string;
};

type PaginatedGames = {
  data: GameItem[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
};

type PackCard = {
  id: string;
  cardId: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number;
  rarity: string | null;
  setName: string | null;
  weight: number;
  probability: number;
  color: string | null;
  animation: boolean;
  order: number;
};

// ─── Pack content tab nav (URL-driven, lazy) ───────────────────────
//
// The pack-detail page has two content surfaces: the Cards pool (cheap,
// already loaded with the pack via getPackDetail) and the Games feed
// (heavy — unindexed JSON full-scans over provably_fair_results keyed on
// result_metadata->>'pack_id'). The old client `<Tabs>` defaulted to
// Cards but still had the *server page* eager-fetch the Games data on
// mount so it could hand <GamesTable> its `initialGames` — meaning a
// hidden tab paid for its scans on every page load, violating the
// Active-Tab-Only rule in CLAUDE.md.
//
// This nav switches the active tab via the `?packTab=` URL param
// (mirroring the /insights/games tab nav) so the server page can parse
// the active tab and render ONLY that tab's content. The Games data is
// then fetched inside a server <Suspense> boundary that only mounts when
// packTab === "games" — i.e. on click, never on the initial Cards view.
// Same fade-mask + horizontal-scroll affordance as the insights/analytics
// tab strips so the visual language stays consistent.

export type PackContentTab = "cards" | "games";

export function parsePackContentTab(value: string | undefined): PackContentTab {
  return value === "games" ? "games" : "cards";
}

const PACK_TABS: {
  value: PackContentTab;
  label: string;
  icon: typeof Layers;
}[] = [
  { value: "cards", label: "Cards", icon: Layers },
  { value: "games", label: "Games", icon: Gamepad2 },
];

export function PackContentTabsNav({ cardCount }: { cardCount: number }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = parsePackContentTab(searchParams.get("packTab") ?? undefined);

  function hrefFor(tab: PackContentTab): string {
    const p = new URLSearchParams(searchParams.toString());
    if (tab === "cards") p.delete("packTab");
    else p.set("packTab", tab);
    const qs = p.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  return (
    <div
      className={cn(
        "flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/50 p-1",
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]",
        "lg:[mask-image:none]",
      )}
    >
      {PACK_TABS.map(({ value, label, icon: Icon }) => (
        <Link
          key={value}
          href={hrefFor(value)}
          replace
          prefetch={false}
          aria-current={current === value ? "page" : undefined}
          className={cn(
            "flex shrink-0 scroll-mx-4 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            current === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" />
          {label}
          {value === "cards" && (
            <span className="text-xs text-muted-foreground">({cardCount})</span>
          )}
        </Link>
      ))}
      {/* Trailing spacer so the last tab can scroll clear of the right-edge
          fade-mask on mobile instead of sitting half-faded under it. shrink-0
          keeps it from collapsing; hidden on lg where the mask is removed. */}
      <span aria-hidden className="shrink-0 pr-4 lg:hidden" />
    </div>
  );
}

// ─── Pack cards view ───────────────────────────────────────────────
//
// The pack's card pool is the operator's primary read on this page:
// "what can drop, and how likely is each one." The old display crammed
// every card into a dense 10-per-row catalog grid where the name was a
// truncated 11px line and the drop chance lived in a tiny shared row
// behind a hairline bar — effectively unreadable. This view makes the
// NAME + DROP CHANCE the visual focus: a scannable, sortable table by
// default (large name, large %, rarity-tinted odds bar, value), with an
// optional roomier grid for a visual browse. No data is changed — the
// `probability` (0–100) and `priceUsd` come straight from getPackDetail.

type CardSort =
  | "prob-desc"
  | "prob-asc"
  | "value-desc"
  | "value-asc"
  | "order-asc";

const CARD_SORT_OPTIONS: { label: string; value: CardSort }[] = [
  { label: "Drop chance ↓", value: "prob-desc" },
  { label: "Drop chance ↑", value: "prob-asc" },
  { label: "Value ↓", value: "value-desc" },
  { label: "Value ↑", value: "value-asc" },
  { label: "Pack order", value: "order-asc" },
];

// Probability arrives as a 0–100 percentage. Sub-1% slots get a finer
// 4-decimal format so rare cards stay legible instead of rounding to
// "0.00%". Mirrors the precision rule the old tile used.
function formatProbability(probability: number): string {
  if (probability <= 0) return "0%";
  return probability < 0.01
    ? `${probability.toFixed(4)}%`
    : `${probability.toFixed(2)}%`;
}

// Rarity badge tint — reuses the House-neutral rarity vocabulary already
// shared across /cards + /packs via card-tile's dot/ring helpers, mapped
// to the project's badge token shape (bg/text/border). Rarity is an
// identity signal here, not a financial one, so these are descriptive
// hues (not House-POV) — exactly like the existing rarity chips.
const RARITY_BADGE: Record<string, string> = {
  common: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  uncommon:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  rare: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  "ultra rare":
    "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  "secret rare":
    "bg-pink-500/15 text-pink-600 dark:text-pink-400 border-pink-500/30",
  secret:
    "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  legendary:
    "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  holo: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
};

function rarityBadgeClass(rarity: string | null): string {
  return (
    RARITY_BADGE[(rarity ?? "").toLowerCase()] ??
    "bg-muted text-muted-foreground border-border"
  );
}

export function PackCardsView({ cards }: { cards: PackCard[] }) {
  const [view, setView] = useState<"table" | "grid">("table");
  const [searchInput, setSearchInput] = useState("");
  const [sort, setSort] = useState<CardSort>("prob-desc");

  const filtered = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    const rows = q
      ? cards.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            (c.setName ?? "").toLowerCase().includes(q) ||
            (c.rarity ?? "").toLowerCase().includes(q),
        )
      : cards.slice();
    rows.sort((a, b) => {
      switch (sort) {
        case "prob-asc":
          return a.probability - b.probability;
        case "value-desc":
          return b.priceUsd - a.priceUsd;
        case "value-asc":
          return a.priceUsd - b.priceUsd;
        case "order-asc":
          return a.order - b.order;
        case "prob-desc":
        default:
          return b.probability - a.probability;
      }
    });
    return rows;
  }, [cards, searchInput, sort]);

  // The widest single drop-chance in the pool — the odds bars are scaled
  // relative to it so a pool where the top card is 8% still produces a
  // readable bar instead of a sliver against a 0–100 axis. Purely a
  // display normalization; the % labels remain the true probabilities.
  const maxProbability = useMemo(
    () => cards.reduce((max, c) => Math.max(max, c.probability), 0),
    [cards],
  );

  if (cards.length === 0) {
    return (
      <Card>
        <CardContent className="flex h-24 items-center justify-center text-muted-foreground">
          No cards in this pack.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar: search + sort + view toggle. Sort defaults to drop
          chance descending so the most-likely pulls lead the list. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[160px] flex-1 sm:max-w-[240px]">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search card, set, or rarity..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-9 pl-8 text-sm"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {CARD_SORT_OPTIONS.map((s) => (
            <Button
              key={s.value}
              variant={sort === s.value ? "default" : "outline"}
              size="sm"
              className="h-9 px-2.5 text-xs"
              onClick={() => setSort(s.value)}
            >
              {s.label}
            </Button>
          ))}
        </div>
        {/* View toggle — table (default, max readability for name + %) vs
            a roomier visual grid. */}
        <div className="ml-auto inline-flex items-center rounded-lg border p-0.5">
          <Button
            variant={view === "table" ? "default" : "ghost"}
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs"
            onClick={() => setView("table")}
            aria-pressed={view === "table"}
          >
            <Rows3 className="size-3.5" />
            Table
          </Button>
          <Button
            variant={view === "grid" ? "default" : "ghost"}
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs"
            onClick={() => setView("grid")}
            aria-pressed={view === "grid"}
          >
            <LayoutGrid className="size-3.5" />
            Grid
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No cards match your search"
          description="Try a different card name, set, or rarity."
          compact
        />
      ) : view === "table" ? (
        <PackCardsTable cards={filtered} maxProbability={maxProbability} />
      ) : (
        <PackCardsGrid cards={filtered} maxProbability={maxProbability} />
      )}
    </div>
  );
}

function PackCardsTable({
  cards,
  maxProbability,
}: {
  cards: PackCard[];
  maxProbability: number;
}) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-12 text-center">#</TableHead>
              <TableHead>Card</TableHead>
              <TableHead className="hidden sm:table-cell">Rarity</TableHead>
              <TableHead className="min-w-[180px]">Drop chance</TableHead>
              <TableHead className="text-right">Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cards.map((card) => {
              const dot = getRarityDot(card.rarity);
              const ring = getRarityRing(card.rarity);
              // Bar fills relative to the pool's widest slot so even a
              // low-odds pool stays visually legible (label is the true %).
              const barPct =
                maxProbability > 0
                  ? Math.max(2, (card.probability / maxProbability) * 100)
                  : 0;
              return (
                <TableRow key={card.id} className="group">
                  <TableCell className="text-center text-xs font-mono tabular-nums text-muted-foreground">
                    {card.order}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/cards/${card.cardId}`}
                      className="flex items-center gap-3"
                    >
                      <div
                        className={cn(
                          "size-11 shrink-0 overflow-hidden rounded-lg bg-muted/40 ring-1",
                          ring,
                        )}
                      >
                        <CardImage
                          src={card.imageUrl}
                          alt={card.name}
                          className="size-full"
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className={cn(
                              "size-2 shrink-0 rounded-full",
                              dot,
                            )}
                          />
                          <span className="truncate text-sm font-semibold leading-tight group-hover:text-primary">
                            {card.name}
                          </span>
                        </div>
                        {card.setName && (
                          <p className="truncate pl-3.5 text-xs text-muted-foreground">
                            {card.setName}
                          </p>
                        )}
                      </div>
                    </Link>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {card.rarity ? (
                      <span
                        className={cn(
                          "inline-block rounded-md border px-2 py-0.5 text-[11px] font-medium capitalize",
                          rarityBadgeClass(card.rarity),
                        )}
                      >
                        {card.rarity}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <span className="w-[72px] shrink-0 text-base font-bold tabular-nums">
                        {formatProbability(card.probability)}
                      </span>
                      <div
                        className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
                        aria-hidden
                      >
                        <div
                          className={cn("h-full rounded-full", dot)}
                          style={{ width: `${Math.min(barPct, 100)}%` }}
                        />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="text-sm font-semibold tabular-nums">
                      {card.priceUsd > 0 ? (
                        formatCurrency(card.priceUsd)
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function PackCardsGrid({
  cards,
  maxProbability,
}: {
  cards: PackCard[];
  maxProbability: number;
}) {
  return (
    // Roomier than the dense catalog grid (2→3→4→5→6, not …→10) so each
    // tile has space for a prominent, readable drop-chance block under
    // the card. Reuses the shared <CardTile> for the image/name/rarity/
    // price so the visual vocabulary stays consistent with /cards.
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {cards.map((card) => {
        const dot = getRarityDot(card.rarity);
        const barPct =
          maxProbability > 0
            ? Math.max(2, (card.probability / maxProbability) * 100)
            : 0;
        return (
          <CardTile
            key={card.id}
            id={card.id}
            href={`/cards/${card.cardId}`}
            name={card.name}
            imageUrl={card.imageUrl}
            rarity={card.rarity}
            subtitle={card.setName ?? null}
            topBadge={`#${card.order}`}
            priceUsd={card.priceUsd}
            extraRows={
              <div className="mt-0.5 rounded-lg border bg-muted/30 px-2 py-1.5">
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Drop
                  </span>
                  <span className="text-sm font-bold tabular-nums leading-none">
                    {formatProbability(card.probability)}
                  </span>
                </div>
                <div
                  className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
                  aria-hidden
                >
                  <div
                    className={cn("h-full rounded-full", dot)}
                    style={{ width: `${Math.min(barPct, 100)}%` }}
                  />
                </div>
              </div>
            }
          />
        );
      })}
    </div>
  );
}

const TYPE_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Solo", value: "solo" },
  { label: "Battle", value: "battle" },
];

const SORT_OPTIONS = [
  { label: "Newest", value: "date-desc" },
  { label: "Oldest", value: "date-asc" },
  { label: "Payout ↑", value: "payout-asc" },
  { label: "Payout ↓", value: "payout-desc" },
];

export function GamesTable({ packId, initialGames }: { packId: string; initialGames: PaginatedGames }) {
  const [games, setGames] = useState(initialGames);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sort, setSort] = useState("date-desc");

  const { data, totalPages, total } = games;
  const hasFilters = dateFrom !== "" || dateTo !== "" || search !== "" || typeFilter !== "all";

  const load = async (overrides: Record<string, unknown> = {}) => {
    const p = (overrides.page as number) ?? page;
    const [sortBy, sortOrder] = ((overrides.sort as string) ?? sort).split("-");
    const filters = {
      dateFrom: ((overrides.dateFrom as string) ?? dateFrom) || undefined,
      dateTo: ((overrides.dateTo as string) ?? dateTo) || undefined,
      search: ((overrides.search as string) ?? search) || undefined,
      type: ((overrides.type as string) ?? typeFilter) || undefined,
      sortBy,
      sortOrder,
    };
    setLoading(true);
    try {
      const res = await fetchPackGames(packId, p, 20, filters);
      setGames(res);
    } catch (err) {
      // Keep the currently-shown games in place and surface the failure as a
      // toast (mirrors the sibling client action handlers) instead of leaving
      // an uncaught client-promise rejection + a stuck spinner. The initial
      // Games load is server-hardened by GamesTabSection (safeQuery+timeout);
      // this guards the client-side pagination/filter refetches.
      toast.error(
        err instanceof Error ? err.message : "Couldn't load games",
      );
    } finally {
      setLoading(false);
    }
  };

  const updateFilter = (key: string, value: string) => {
    const updates: Record<string, unknown> = { [key]: value, page: 1 };
    if (key === "dateFrom") setDateFrom(value);
    else if (key === "dateTo") setDateTo(value);
    else if (key === "search") setSearch(value);
    else if (key === "type") setTypeFilter(value);
    else if (key === "sort") setSort(value);
    setPage(1);
    load(updates);
  };

  const navigate = (newPage: number) => {
    setPage(newPage);
    load({ page: newPage });
  };

  const clearFilters = () => {
    setDateFrom("");
    setDateTo("");
    setSearch("");
    setSearchInput("");
    setTypeFilter("all");
    setSort("date-desc");
    setPage(1);
    load({ dateFrom: "", dateTo: "", search: "", type: "all", sort: "date-desc", page: 1 });
  };

  // Debounced search: typing updates `searchInput` instantly (responsive
  // field) and commits to the actual `search` filter 300ms after the last
  // keystroke, so the operator no longer has to press Enter and we don't
  // refetch on every character. The committing logic lives behind a ref so the
  // debounce effect stays scoped to `searchInput` alone (no refetch storm on
  // unrelated re-renders) without going stale. Enter still commits instantly
  // via onKeyDown; the ref-guard skips a redundant refetch when the debounced
  // value already matches what's committed.
  const commitSearchRef = useRef<(value: string) => void>(() => {});
  commitSearchRef.current = (value: string) => {
    if (value === search) return;
    updateFilter("search", value);
  };
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      commitSearchRef.current(searchInput);
    }, 300);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchInput]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">Games ({total})</CardTitle>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="size-7" onClick={() => navigate(1)} disabled={page <= 1 || loading}>
                <ChevronsLeft className="size-3" />
              </Button>
              <Button variant="outline" size="icon" className="size-7" onClick={() => navigate(page - 1)} disabled={page <= 1 || loading}>
                <ChevronLeft className="size-3" />
              </Button>
              <span className="px-2 text-xs text-muted-foreground">{page} / {totalPages}</span>
              <Button variant="outline" size="icon" className="size-7" onClick={() => navigate(page + 1)} disabled={page >= totalPages || loading}>
                <ChevronRight className="size-3" />
              </Button>
              <Button variant="outline" size="icon" className="size-7" onClick={() => navigate(totalPages)} disabled={page >= totalPages || loading}>
                <ChevronsRight className="size-3" />
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2 pt-2">
          <div className="relative flex-1 min-w-[140px] sm:max-w-[200px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Search user..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // Commit immediately and cancel the pending debounce so the
                  // 300ms timer doesn't fire a redundant no-op afterwards.
                  if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
                  updateFilter("search", searchInput);
                }
              }}
              className="h-8 pl-7 text-xs"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {TYPE_OPTIONS.map((t) => (
              <Button
                key={t.value}
                variant={typeFilter === t.value ? "default" : "outline"}
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => updateFilter("type", t.value)}
              >
                {t.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {SORT_OPTIONS.map((s) => (
              <Button
                key={s.value}
                variant={sort === s.value ? "default" : "outline"}
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => updateFilter("sort", s.value)}
              >
                {s.label}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Input type="date" value={dateFrom} onChange={(e) => updateFilter("dateFrom", e.target.value)} className="h-8 w-[120px] text-xs" />
            <span className="text-xs text-muted-foreground">–</span>
            <Input type="date" value={dateTo} onChange={(e) => updateFilter("dateTo", e.target.value)} className="h-8 w-[120px] text-xs" />
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" className="h-8 text-xs px-2" onClick={clearFilters}>
              <X className="size-3 mr-1" /> Clear
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          // Standalone skeleton during a pagination/filter refetch — replaces
          // the old dim-overlay-with-spinner so the swap reads as a clean
          // placeholder block (dark-safe, no motion) instead of a greyed-out
          // stale table. Height roughly reserves the populated table.
          <Skeleton className="h-96 w-full rounded-lg" />
        ) : data.length === 0 ? (
          <EmptyState
            icon={Search}
            title={hasFilters ? "No games match your filters" : "No games played yet"}
            description={
              hasFilters
                ? "Try a different user, type, or date range."
                : "Opens of this pack will appear here once players start unboxing it."
            }
            compact
          />
        ) : (
          <div className="overflow-x-auto -mx-6 px-6 sm:mx-0 sm:px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Card</TableHead>
                <TableHead>Card Value</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((g) => (
                <TableRow key={g.id}>
                  <TableCell>
                    {g.userId ? (
                      <Link href={`/users/${g.userId}`} className="hover:underline">
                        <span className="font-medium">{g.username ?? g.email ?? "Unknown"}</span>
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        g.type === "battle"
                          ? "bg-blue-500/15 text-blue-400"
                          : "bg-zinc-500/15 text-zinc-400"
                      }`}>
                        {g.type}
                      </span>
                      {g.isBorrowed && (
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/15 text-amber-400">
                          borrow
                        </span>
                      )}
                      {g.isSponsored && (
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold bg-purple-500/15 text-purple-400">
                          sponsored
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {g.cardName ? (
                      <div className="flex items-center gap-2">
                        <div className="size-8 shrink-0 rounded border bg-muted overflow-hidden">
                          <CardImage src={g.cardImageUrl} alt={g.cardName} className="size-full" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-medium truncate">{g.cardName}</p>
                          {g.cardRarity && (
                            <span className={`inline-block rounded px-1 py-0.5 text-[9px] ${
                              RARITY_COLORS[g.cardRarity.toLowerCase()] ?? "bg-black/80 text-white"
                            }`}>
                              {g.cardRarity}
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="font-medium tabular-nums">
                      {formatCurrency(g.cardPrice)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatDateTime(g.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
