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
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { fetchPackGames } from "../actions";

const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-700/90 text-zinc-100",
  uncommon: "bg-green-700/90 text-green-100",
  rare: "bg-blue-700/90 text-blue-100",
  "ultra rare": "bg-purple-700/90 text-purple-100",
  "secret rare": "bg-yellow-600/90 text-yellow-100",
  legendary: "bg-orange-600/90 text-orange-100",
  holo: "bg-cyan-700/90 text-cyan-100",
  secret: "bg-pink-700/90 text-pink-100",
};

type CardWon = {
  name: string;
  imageUrl: string | null;
  rarity: string | null;
  priceUsd: number;
};

type GameItem = {
  id: string;
  userId: string | null;
  username: string | null;
  email: string | null;
  betAmount: number;
  cardsWon: CardWon[];
  totalPayout: number;
  betTxId: string | null;
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
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {data.cards.map((card) => (
                <div
                  key={card.id}
                  className="rounded-lg border bg-card overflow-hidden"
                >
                  <div className="aspect-[2/3] relative bg-muted">
                    <CardImage
                      src={card.imageUrl}
                      alt={card.name}
                      className="size-full"
                    />
                    {card.rarity && (
                      <span
                        className={`absolute bottom-1.5 left-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold leading-none shadow backdrop-blur-sm ${RARITY_COLORS[card.rarity.toLowerCase()] ?? "bg-black/80 text-white"}`}
                      >
                        {card.rarity}
                      </span>
                    )}
                    <span className="absolute top-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-mono text-white/80 shadow backdrop-blur-sm">
                      #{card.order}
                    </span>
                  </div>
                  <div className="p-2 space-y-1">
                    <p className="text-xs font-medium truncate" title={card.name}>
                      {card.name}
                    </p>
                    {card.setName && (
                      <p className="text-[10px] text-muted-foreground truncate">
                        {card.setName}
                      </p>
                    )}
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-medium">{formatCurrency(card.priceUsd)}</span>
                      <span className="text-muted-foreground">{card.probability < 0.01 ? card.probability.toFixed(4) : card.probability.toFixed(2)}%</span>
                    </div>
                    <div className="h-1 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary/60"
                        style={{ width: `${Math.min(card.probability, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
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

function GamesTable({ packId, initialGames }: { packId: string; initialGames: PaginatedGames }) {
  const [games, setGames] = useState(initialGames);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const { data, totalPages, total } = games;

  const hasFilters = dateFrom !== "" || dateTo !== "" || search !== "";

  const load = async (overrides: Record<string, unknown> = {}) => {
    const p = (overrides.page as number) ?? page;
    const filters = {
      dateFrom: ((overrides.dateFrom as string) ?? dateFrom) || undefined,
      dateTo: ((overrides.dateTo as string) ?? dateTo) || undefined,
      search: ((overrides.search as string) ?? search) || undefined,
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
    setPage(1);
    load({ dateFrom: "", dateTo: "", search: "", page: 1 });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
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
          <div className="relative flex-1 min-w-[140px] max-w-[220px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Search user..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") updateFilter("search", searchInput); }}
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => updateFilter("dateFrom", e.target.value)}
            className="h-8 w-[130px] text-xs"
          />
          <span className="text-xs text-muted-foreground">-</span>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => updateFilter("dateTo", e.target.value)}
            className="h-8 w-[130px] text-xs"
          />
          {hasFilters && (
            <Button variant="ghost" size="sm" className="h-8 text-xs px-2" onClick={clearFilters}>
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
        {data.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">
            {hasFilters ? "No games match your filters" : "No games played yet"}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Bet</TableHead>
                <TableHead>Cards Won</TableHead>
                <TableHead>Payout</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="w-[100px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((game) => (
                <TableRow key={game.id}>
                  <TableCell>
                    {game.userId ? (
                      <Link href={`/users/${game.userId}`} className="hover:underline">
                        <span className="font-medium">{game.username ?? game.email ?? "Unknown"}</span>
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">Bot</span>
                    )}
                  </TableCell>
                  <TableCell className="font-medium">{formatCurrency(game.betAmount)}</TableCell>
                  <TableCell>
                    {game.cardsWon.length > 0 ? (
                      <div className="flex items-center gap-1">
                        {game.cardsWon.slice(0, 3).map((card, i) => (
                          <div key={i} className="group relative">
                            <div className="size-8 rounded border bg-muted overflow-hidden">
                              <CardImage src={card.imageUrl} alt={card.name} className="size-full" />
                            </div>
                            <div className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1 hidden group-hover:block z-50">
                              <div className="rounded bg-popover border px-2 py-1 text-xs shadow-md whitespace-nowrap">
                                <p className="font-medium">{card.name}</p>
                                {card.rarity && (
                                  <span className={`inline-block rounded px-1 py-0.5 text-[10px] mt-0.5 ${RARITY_COLORS[card.rarity.toLowerCase()] ?? "bg-black/80 text-white"}`}>
                                    {card.rarity}
                                  </span>
                                )}
                                <p className="text-muted-foreground">{formatCurrency(card.priceUsd)}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                        {game.cardsWon.length > 3 && (
                          <span className="text-xs text-muted-foreground">+{game.cardsWon.length - 3}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className={`font-medium ${game.totalPayout > game.betAmount ? "text-red-400" : "text-green-400"}`}>
                      {formatCurrency(game.totalPayout)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatDateTime(game.createdAt)}
                  </TableCell>
                  <TableCell>
                    {game.betTxId && (
                      <Link
                        href={`/transactions/${game.betTxId}`}
                        className="text-xs text-primary hover:underline whitespace-nowrap"
                      >
                        View game
                      </Link>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
