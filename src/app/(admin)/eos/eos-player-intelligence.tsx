"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  CircleDollarSign,
  Loader2,
  Search,
  Sparkles,
  Target,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { EosUserConfig } from "@/lib/antifraud/eos-test-config-api";
import type {
  EosPlayerIntelligence,
  EosPlayerIntelligenceInput,
  EosPlayerSignal,
} from "@/lib/eos-player-intelligence-shared";
import { cn } from "@/lib/utils";
import { loadEosPlayerIntelligence } from "./actions";

const SORT_LABELS: Record<EosPlayerIntelligenceInput["sort"], string> = {
  luck: "Luck signal",
  battles: "Most battles",
  volume: "Highest volume",
  largest: "Largest battle",
};

function percent(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function amount(value: number, currency: EosPlayerIntelligence["currency"]) {
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value)} ${currency}`;
}

function signalBadge(signal: EosPlayerSignal["signal"]) {
  if (signal === "strong") return <Badge variant="destructive">Strong signal</Badge>;
  if (signal === "elevated") {
    return (
      <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
        Elevated
      </Badge>
    );
  }
  return <Badge variant="outline">Normal range</Badge>;
}

export function EosPlayerIntelligencePanel({
  active,
  configuredUsers,
  onConfigure,
}: {
  active: boolean;
  configuredUsers: EosUserConfig[];
  onConfigure: (player: EosPlayerSignal) => void;
}) {
  const [filters, setFilters] = useState<EosPlayerIntelligenceInput>({
    period: "7d",
    currency: "real",
    sort: "luck",
    minBattles: 5,
    minBattleValue: 0,
    limit: 50,
  });
  const [data, setData] = useState<EosPlayerIntelligence | null>(null);
  const [query, setQuery] = useState("");
  const [signalView, setSignalView] = useState<"all" | "flagged">("all");
  const [isPending, startTransition] = useTransition();
  const attemptedInitialLoad = useRef(false);
  const configuredById = useMemo(
    () => new Map(configuredUsers.map((config) => [config.userId, config])),
    [configuredUsers],
  );

  function load(next = filters) {
    startTransition(async () => {
      try {
        const result = await loadEosPlayerIntelligence(next);
        setData(result);
      } catch (error) {
        toast.error(error instanceof Error
          ? error.message
          : "Player intelligence could not be loaded");
      }
    });
  }

  useEffect(() => {
    if (!active || attemptedInitialLoad.current) return;
    attemptedInitialLoad.current = true;
    load();
    // This fetch starts only when the operator opens the tab. Filter changes
    // remain explicit, and a failed initial request waits for a manual retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const visibleRows = data?.rows.filter((row) => {
    const needle = query.trim().toLowerCase();
    return needle.length === 0
      || row.userId.toLowerCase().includes(needle)
      || row.username?.toLowerCase().includes(needle);
  }).filter((row) => signalView === "all" || row.signal !== "none") ?? [];
  const signaled = data?.rows.filter((row) => row.signal !== "none").length ?? 0;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <h2 className="font-semibold">EOS-targetable creator signals</h2>
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              Ranks completed battles created by each player. Luck compares observed wins with
              equal-team expectations; group and jackpot battles stay in activity totals but
              are excluded from the statistical score.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
            <Select
              value={filters.period}
              onValueChange={(period) => period && setFilters((current) => ({
                ...current,
                period: period as EosPlayerIntelligenceInput["period"],
              }))}
            >
              <SelectTrigger aria-label="Signal period"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="24h">Last 24 hours</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filters.currency}
              onValueChange={(currency) => currency && setFilters((current) => ({
                ...current,
                currency: currency as EosPlayerIntelligenceInput["currency"],
              }))}
            >
              <SelectTrigger aria-label="Signal currency"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="real">Real balance</SelectItem>
                <SelectItem value="coin">Coins</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filters.sort}
              onValueChange={(sort) => sort && setFilters((current) => ({
                ...current,
                sort: sort as EosPlayerIntelligenceInput["sort"],
              }))}
            >
              <SelectTrigger aria-label="Player ranking"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(SORT_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={String(filters.minBattles)}
              onValueChange={(value) => value && setFilters((current) => ({
                ...current,
                minBattles: Number(value),
              }))}
            >
              <SelectTrigger aria-label="Minimum battles"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[1, 5, 10, 25, 50].map((value) => (
                  <SelectItem key={value} value={String(value)}>Min. {value} battles</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={1_000_000}
              step="any"
              value={filters.minBattleValue}
              onChange={(event) => setFilters((current) => ({
                ...current,
                minBattleValue: Math.min(
                  1_000_000,
                  Math.max(0, Number(event.target.value) || 0),
                ),
              }))}
              aria-label={`Minimum battle value in ${filters.currency}`}
              placeholder="Min. battle value"
            />
            <Button type="button" disabled={isPending} onClick={() => load()}>
              {isPending ? <Loader2 className="size-4 animate-spin" /> : <BarChart3 className="size-4" />}
              Apply
            </Button>
          </div>
        </div>
      </div>

      {data && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            [Activity, "Matching creators", data.matchingPlayers.toLocaleString()],
            [Target, "Completed battles", data.matchingBattles.toLocaleString()],
            [AlertTriangle, "Elevated signals", signaled.toLocaleString()],
            [CircleDollarSign, "Ranked currency", data.currency === "real" ? "Real balance" : "Coins"],
          ].map(([Icon, label, value]) => {
            const MetricIcon = Icon as typeof Activity;
            return (
              <Card key={String(label)} size="sm">
                <CardContent className="flex items-center gap-3">
                  <span className="rounded-lg bg-primary/10 p-2 text-primary"><MetricIcon className="size-4" /></span>
                  <div>
                    <p className="text-xs text-muted-foreground">{String(label)}</p>
                    <p className="font-semibold tabular-nums">{String(value)}</p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="border-b bg-muted/20">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base">Creator ranking</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                A signal is a review lead, not proof of abuse or manipulation.
              </p>
            </div>
            <div className="flex w-full gap-2 sm:w-auto">
              <Select
                value={signalView}
                onValueChange={(value) => value && setSignalView(value as "all" | "flagged")}
              >
                <SelectTrigger className="w-36" aria-label="Filter luck signals"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All creators</SelectItem>
                  <SelectItem value="flagged">Signals only</SelectItem>
                </SelectContent>
              </Select>
              <div className="relative min-w-0 flex-1 sm:w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="pl-9"
                  placeholder="Filter player or ID"
                  aria-label="Filter ranked EOS creators"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isPending && data === null && (
            <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />Analyzing completed battles…
            </div>
          )}
          {!isPending && data && visibleRows.length === 0 && (
            <div className="p-12 text-center text-sm text-muted-foreground">
              No creators match these filters.
            </div>
          )}
          {data && visibleRows.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Creator</TableHead>
                    <TableHead>Luck signal</TableHead>
                    <TableHead className="text-right">Wins</TableHead>
                    <TableHead className="text-right">Battles</TableHead>
                    <TableHead className="text-right">Total cost</TableHead>
                    <TableHead className="text-right">Largest</TableHead>
                    <TableHead className="text-right">Est. P&amp;L</TableHead>
                    <TableHead><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.map((row) => {
                    const configured = configuredById.get(row.userId);
                    return (
                      <TableRow key={row.userId}>
                        <TableCell>
                          <div className="max-w-52">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-medium">{row.username ?? "Unnamed creator"}</span>
                              {configured?.forceLosses ? (
                                <Badge variant="destructive" className="text-[9px]">Lose only</Badge>
                              ) : configured ? (
                                <Badge variant="secondary" className="text-[9px]">
                                  {configured.enabled ? "Flow active" : "Flow paused"}
                                </Badge>
                              ) : null}
                            </div>
                            <p className="truncate font-mono text-[10px] text-muted-foreground">{row.userId}</p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {signalBadge(row.signal)}
                            <p className={cn(
                              "text-[10px] tabular-nums text-muted-foreground",
                              row.signal !== "none" && "font-medium text-foreground",
                            )}>
                              {row.luckScore === null ? "Not comparable" : `z ${row.luckScore.toFixed(2)}`}
                              {` · ${row.luckWins}/${row.luckEligibleBattles} vs ${row.expectedWins.toFixed(1)} expected`}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <span className="font-medium">{percent(row.winRate)}</span>
                          <span className="block text-[10px] text-muted-foreground">
                            {row.wins}–{row.losses} · expected {percent(row.expectedWinRate)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{row.battleCount}</TableCell>
                        <TableCell className="text-right tabular-nums">{amount(row.totalCreatorCost, data.currency)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {amount(row.largestCreatorCost, data.currency)}
                          <span className="block text-[10px] text-muted-foreground">
                            pot {amount(row.largestPotValue, data.currency)}
                          </span>
                        </TableCell>
                        <TableCell className={cn(
                          "text-right font-medium tabular-nums",
                          row.estimatedNetPnl > 0 && "text-emerald-600 dark:text-emerald-400",
                          row.estimatedNetPnl < 0 && "text-destructive",
                        )}>
                          {amount(row.estimatedNetPnl, data.currency)}
                          <span className="block text-[10px] font-normal text-muted-foreground">estimated</span>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button type="button" size="sm" variant="outline" onClick={() => onConfigure(row)}>
                              Configure
                            </Button>
                            <Button
                              nativeButton={false}
                              render={<Link href={`/users/${encodeURIComponent(row.userId)}`} />}
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Open ${row.username ?? row.userId}`}
                            >
                              <ArrowUpRight className="size-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
