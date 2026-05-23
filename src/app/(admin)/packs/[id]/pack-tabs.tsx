"use client";

import { useState } from "react";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2, Search, X } from "lucide-react";
import { CardImage } from "@/components/card-image";
import { CardTile, TileDataRow } from "@/components/card-tile";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
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

type PackDetailData = {
  id: string;
  name: string;
  active: boolean;
  cards: {
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
  }[];
};

export function PackTabs({ data, initialGames }: { data: PackDetailData; initialGames: PaginatedGames }) {
  return (
    <div className="space-y-4">
      <Tabs defaultValue="cards">
        <TabsList>
          <TabsTrigger value="cards">Cards ({data.cards.length})</TabsTrigger>
          <TabsTrigger value="games">Games</TabsTrigger>
        </TabsList>

        <TabsContent value="cards">
          {data.cards.length === 0 ? (
            <Card>
              <CardContent className="flex h-24 items-center justify-center text-muted-foreground">
                No cards in this pack.
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-10">
              {data.cards.map((card) => {
                // Probability comes through as 0-100 already. Tiny values
                // (sub 1%) get a finer 4-decimal format so rare slots stay
                // legible in the tile.
                const probLabel =
                  card.probability < 0.01
                    ? `${card.probability.toFixed(4)}%`
                    : `${card.probability.toFixed(2)}%`;
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
                      <>
                        <TileDataRow
                          label={
                            card.rarity ? (
                              <span className="capitalize">{card.rarity}</span>
                            ) : (
                              "—"
                            )
                          }
                          value={probLabel}
                        />
                        {/* Probability bar — slimmer than before but still
                            gives operators an at-a-glance weight signal. */}
                        <div
                          className="h-0.5 overflow-hidden rounded-full bg-muted"
                          aria-hidden
                        >
                          <div
                            className="h-full rounded-full bg-primary/60"
                            style={{
                              width: `${Math.min(card.probability, 100)}%`,
                            }}
                          />
                        </div>
                      </>
                    }
                  />
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="games">
          <GamesTable packId={data.id} initialGames={initialGames} />
        </TabsContent>

      </Tabs>
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

function GamesTable({ packId, initialGames }: { packId: string; initialGames: PaginatedGames }) {
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
              onKeyDown={(e) => { if (e.key === "Enter") updateFilter("search", searchInput); }}
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
      <CardContent className="relative">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 rounded-b-lg">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {data.length === 0 ? (
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
