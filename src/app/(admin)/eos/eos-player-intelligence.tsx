"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  CircleDollarSign,
  Loader2,
  Search,
  Target,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";

import { MobileCard } from "@/components/data-table/mobile-card-list";
import { EmptyState } from "@/components/empty-state";
import { KpiTile } from "@/components/modern-panels";
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
  EosPlayerImpact,
} from "@/lib/eos-player-intelligence-shared";
import { cn } from "@/lib/utils";
import { loadEosPlayerIntelligence } from "./actions";

const SORT_LABELS: Record<EosPlayerIntelligenceInput["sort"], string> = {
  profit: "Highest player profit",
  battles: "Most battles",
  volume: "Highest creator exposure",
  largest: "Largest creator exposure",
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

function PlayerStatus({ config }: { config?: EosUserConfig }) {
  if (config?.forceLosses) return <Badge variant="destructive">Lose only</Badge>;
  if (!config) return null;
  return (
    <Badge variant={config.enabled ? "secondary" : "outline"}>
      {config.enabled ? "Flow active" : "Flow paused"}
    </Badge>
  );
}

export function EosPlayerIntelligencePanel({
  active,
  configuredUsers,
  onConfigure,
}: {
  active: boolean;
  configuredUsers: EosUserConfig[];
  onConfigure: (player: EosPlayerImpact) => void;
}) {
  const [filters, setFilters] = useState<EosPlayerIntelligenceInput>({
    period: "7d",
    currency: "real",
    sort: "profit",
    minBattles: 5,
    minBattleValue: 0,
    limit: 50,
  });
  const [data, setData] = useState<EosPlayerIntelligence | null>(null);
  const [query, setQuery] = useState("");
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
  }) ?? [];

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="size-4 text-primary" />
            Highest-impact battle creators
          </CardTitle>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Rank completed real-balance battles by player profit against the site,
            activity, or creator-funded exposure.
          </p>
        </CardHeader>
        <CardContent className="pt-1">
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-[0.9fr_1.35fr_1fr_1fr_auto] 2xl:items-end">
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              Period
              <Select
                value={filters.period}
                onValueChange={(period) => period && setFilters((current) => ({
                  ...current,
                  period: period as EosPlayerIntelligenceInput["period"],
                }))}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="24h">Last 24 hours</SelectItem>
                  <SelectItem value="7d">Last 7 days</SelectItem>
                  <SelectItem value="30d">Last 30 days</SelectItem>
                </SelectContent>
              </Select>
            </label>

            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              Rank by
              <Select
                value={filters.sort}
                onValueChange={(sort) => sort && setFilters((current) => ({
                  ...current,
                  sort: sort as EosPlayerIntelligenceInput["sort"],
                }))}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(SORT_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              Minimum activity
              <Select
                value={String(filters.minBattles)}
                onValueChange={(value) => value && setFilters((current) => ({
                  ...current,
                  minBattles: Number(value),
                }))}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[1, 5, 10, 25, 50].map((value) => (
                    <SelectItem key={value} value={String(value)}>{value}+ battles</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              Minimum battle value
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
                placeholder="0"
              />
            </label>

            <Button type="button" className="w-full 2xl:w-auto" disabled={isPending} onClick={() => load()}>
              {isPending ? <Loader2 className="size-4 animate-spin" /> : <BarChart3 className="size-4" />}
              Apply
            </Button>
          </div>
        </CardContent>
      </Card>

      {data && (
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          <KpiTile
            icon={Activity}
            label="Matching creators"
            value={data.matchingPlayers.toLocaleString()}
            sub="Meet current filters"
            accent="blue"
          />
          <KpiTile
            icon={Target}
            label="Completed battles"
            value={data.matchingBattles.toLocaleString()}
            sub="Created in this period"
            accent="purple"
          />
          <KpiTile
            icon={TrendingUp}
            label="Creators up vs site"
            value={data.playersUp.toLocaleString()}
            sub="Positive estimated P&L"
            accent="rose"
          />
          <KpiTile
            icon={CircleDollarSign}
            label="Player profit vs site"
            value={amount(data.totalPlayerProfit, data.currency)}
            sub="Estimated creator P&L"
            accent={data.totalPlayerProfit > 0 ? "rose" : "emerald"}
          />
        </div>
      )}

      <Card>
        <CardHeader className="border-b">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <CardTitle>Creator ranking</CardTitle>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                Positive creator P&amp;L means the player is up against the site. Values are settlement estimates.
              </p>
            </div>
            <label className="w-full space-y-1.5 text-xs font-medium text-muted-foreground sm:w-72">
              Filter results
              <span className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="pl-9"
                  placeholder="Player or user ID"
                  aria-label="Filter ranked EOS creators"
                />
              </span>
            </label>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isPending && data === null && (
            <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Analyzing completed battles…
            </div>
          )}

          {!isPending && data && visibleRows.length === 0 && (
            <EmptyState
              icon={Search}
              title="No matching creators"
              description="Adjust the player search or activity filters to broaden the ranking."
              compact
            />
          )}

          {data && visibleRows.length > 0 && (
            <>
              <div className="overflow-hidden md:hidden">
                {visibleRows.map((row) => {
                  const configured = configuredById.get(row.userId);
                  return (
                    <MobileCard
                      key={row.userId}
                      primary={row.username ?? "Unnamed creator"}
                      secondary={<span className="font-mono">{row.userId}</span>}
                      trailing={(
                        <div className={cn(
                          "font-semibold",
                          row.estimatedNetPnl > 0 && "text-rose-600 dark:text-rose-400",
                          row.estimatedNetPnl < 0 && "text-emerald-600 dark:text-emerald-400",
                        )}>
                          {amount(row.estimatedNetPnl, data.currency)}
                          <span className="block font-normal text-muted-foreground">creator P&amp;L</span>
                        </div>
                      )}
                      meta={[
                        <span key="battles">{row.battleCount} battles</span>,
                        <span key="wins">{percent(row.winRate)} wins</span>,
                        <span key="exposure">{amount(row.totalCreatorCost, data.currency)} exposure</span>,
                        <PlayerStatus key="status" config={configured} />,
                      ]}
                      footer={(
                        <div className="flex items-center justify-end gap-2">
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
                      )}
                    />
                  );
                })}
              </div>

              <div className="hidden md:block">
                <Table className="min-w-[980px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Creator</TableHead>
                      <TableHead className="text-right">Creator P&amp;L</TableHead>
                      <TableHead className="text-right">Win rate</TableHead>
                      <TableHead className="text-right">Battles</TableHead>
                      <TableHead className="text-right">Total exposure</TableHead>
                      <TableHead className="text-right">Average</TableHead>
                      <TableHead className="text-right">Largest</TableHead>
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
                                <span className="truncate font-medium">
                                  {row.username ?? "Unnamed creator"}
                                </span>
                                <PlayerStatus config={configured} />
                              </div>
                              <p className="truncate font-mono text-xs text-muted-foreground">
                                {row.userId}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className={cn(
                            "text-right font-semibold tabular-nums",
                            row.estimatedNetPnl > 0 && "text-rose-600 dark:text-rose-400",
                            row.estimatedNetPnl < 0 && "text-emerald-600 dark:text-emerald-400",
                          )}>
                            {amount(row.estimatedNetPnl, data.currency)}
                            <span className="block text-xs font-normal text-muted-foreground">
                              payout {amount(row.estimatedPayout, data.currency)}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            <span className="font-medium">{percent(row.winRate)}</span>
                            <span className="block text-xs text-muted-foreground">
                              {row.wins}–{row.losses}
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            {row.battleCount}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {amount(row.totalCreatorCost, data.currency)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {amount(row.averageCreatorCost, data.currency)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {amount(row.largestCreatorCost, data.currency)}
                            <span className="block text-xs text-muted-foreground">
                              pot {amount(row.largestPotValue, data.currency)}
                            </span>
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
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
