"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { toast } from "sonner";

import { MobileCard } from "@/components/data-table/mobile-card-list";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { loadEosBattles } from "./actions";

type BattleData = Awaited<ReturnType<typeof loadEosBattles>>;
type BattleRow = BattleData["rows"][number];
type ControlFilter = "all" | "controlled" | "random" | "legacy" | "missing";

function amount(value: number | null, currency: string) {
  if (value === null) return "—";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)} ${currency}`;
}

function controlState(row: BattleRow): ControlFilter {
  const selection = row.selection;
  if (!selection) return "missing";
  if (!selection.auditAvailable) return "legacy";
  return selection.configured ? "controlled" : "random";
}

function ControlBadge({ row }: { row: BattleRow }) {
  const selection = row.selection;
  if (!selection) return <Badge variant="destructive">Not recorded</Badge>;
  if (!selection.auditAvailable) {
    return (
      <Badge className="border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300">
        {selection.configured ? "Controlled · legacy" : "Random · legacy"}
      </Badge>
    );
  }
  if (!selection.configured) return <Badge variant="outline">Random · no config</Badge>;
  if (selection.fallbackReason) return <Badge variant="destructive">Fallback</Badge>;
  return <Badge variant="secondary">Control applied</Badge>;
}

function Outcome({ row }: { row: BattleRow }) {
  const won = row.battle.creatorWonBattle;
  return (
    <div>
      <span className="font-semibold text-foreground">
        {won === null ? "Pending" : won ? "Win" : "Loss"}
      </span>
      <span className="block text-xs text-muted-foreground">
        Team {row.battle.creatorTeam}
        {row.battle.winnerTeam === null ? "" : ` · winner ${row.battle.winnerTeam}`}
      </span>
    </div>
  );
}

function Profit({ row }: { row: BattleRow }) {
  const { creatorProfitLoss, creatorMultiplier, currency } = row.battle;
  return (
    <div className={cn(
      "font-semibold tabular-nums",
      (creatorProfitLoss ?? 0) > 0 && "text-rose-600 dark:text-rose-400",
      (creatorProfitLoss ?? 0) < 0 && "text-emerald-600 dark:text-emerald-400",
    )}>
      {amount(creatorProfitLoss, currency)}
      <span className="block text-xs font-normal text-muted-foreground">
        {creatorMultiplier?.toFixed(2) ?? "—"}× multiplier
      </span>
    </div>
  );
}

export function EosBattles({ active }: { active: boolean }) {
  const [data, setData] = useState<BattleData | null>(null);
  const [query, setQuery] = useState("");
  const [controlFilter, setControlFilter] = useState<ControlFilter>("all");
  const [isPending, startTransition] = useTransition();
  const loaded = useRef(false);

  function refresh() {
    startTransition(async () => {
      try {
        setData(await loadEosBattles());
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "EOS battles failed to load");
      }
    });
  }

  useEffect(() => {
    if (!active || loaded.current) return;
    loaded.current = true;
    refresh();
  }, [active]);

  const needle = query.trim().toLowerCase();
  const rows = data?.rows.filter((row) => {
    const matchesQuery = needle.length === 0
      || row.battle.creatorUserId.toLowerCase().includes(needle)
      || row.battle.creatorUsername?.toLowerCase().includes(needle)
      || row.battle.battleId.toLowerCase().includes(needle);
    return matchesQuery
      && (controlFilter === "all" || controlState(row) === controlFilter);
  }) ?? [];
  const controlled = data?.rows.filter((row) => controlState(row) === "controlled").length ?? 0;
  const missing = data?.rows.filter((row) => controlState(row) === "missing").length ?? 0;
  const groupBattles = data?.rows.filter((row) => row.battle.mode === "group").length ?? 0;

  return (
    <div className="min-w-0">
      <Card>
        <CardHeader className="border-b">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <Activity className="size-4 text-primary" />
                Real-balance battles
              </CardTitle>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Badge variant="secondary">{data?.rows.length ?? 0} loaded</Badge>
                <Badge variant="secondary">{controlled} controlled</Badge>
                {groupBattles > 0 && <Badge variant="outline">{groupBattles} group</Badge>}
                {missing > 0 && <Badge variant="destructive">{missing} missing</Badge>}
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={refresh}>
              {isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Refresh
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4 pt-1">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem]">
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              Search battles
              <span className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="pl-9"
                  placeholder="Creator, user ID, or battle ID"
                />
              </span>
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              EOS decision
              <Select
                value={controlFilter}
                onValueChange={(value) => value && setControlFilter(value as ControlFilter)}
              >
                <SelectTrigger className="w-full" aria-label="Filter EOS control status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All control states</SelectItem>
                  <SelectItem value="controlled">Config applied</SelectItem>
                  <SelectItem value="random">No config · random</SelectItem>
                  <SelectItem value="legacy">Legacy record</SelectItem>
                  <SelectItem value="missing">Decision missing</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>

          <details className="rounded-lg bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">How group battles are handled</summary>
            <p className="mt-1.5 max-w-4xl leading-5">
              Everyone belongs to team 1, so the creator outcome is always a win. When a loss is
              requested, EOS falls back to the candidate with the lowest creator profit among the
              five available blocks.
            </p>
          </details>

          {!data && isPending ? (
            <div className="flex min-h-52 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading EOS battles
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-lg border">
              <EmptyState
                icon={Search}
                title="No matching battles"
                description="Try a different creator, battle ID, or EOS decision filter."
                compact
              />
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-lg border md:hidden">
                {rows.map((row) => {
                  const battle = row.battle;
                  return (
                    <MobileCard
                      key={battle.battleId}
                      primary={battle.creatorUsername ?? "Unnamed creator"}
                      secondary={<span className="font-mono">{battle.creatorUserId}</span>}
                      trailing={<Profit row={row} />}
                      meta={[
                        <span key="outcome" className="font-medium text-foreground">
                          {battle.creatorWonBattle === null ? "Pending" : battle.creatorWonBattle ? "Win" : "Loss"}
                        </span>,
                        <span key="mode" className="capitalize">{battle.mode.replaceAll("_", " ")}</span>,
                        <ControlBadge key="control" row={row} />,
                      ]}
                      footer={(
                        <div className="flex items-center justify-between gap-3">
                          <span>{new Date(battle.createdAt).toLocaleString()}</span>
                          <Link
                            href={`/users/${battle.creatorUserId}`}
                            className="font-medium text-primary"
                          >
                            Open creator
                          </Link>
                        </div>
                      )}
                    />
                  );
                })}
              </div>

              <div className="hidden overflow-hidden rounded-lg border md:block">
                <Table className="min-w-[760px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Creator</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead className="text-right">Creator P&amp;L</TableHead>
                      <TableHead>EOS decision</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead><span className="sr-only">Open</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => {
                      const battle = row.battle;
                      return (
                        <TableRow key={battle.battleId}>
                          <TableCell>
                            <p className="max-w-44 truncate font-medium">
                              {battle.creatorUsername ?? "Unnamed creator"}
                            </p>
                            <p className="max-w-44 truncate font-mono text-xs text-muted-foreground">
                              {battle.creatorUserId}
                            </p>
                            <p className="mt-0.5 text-xs capitalize text-muted-foreground">
                              {battle.mode.replaceAll("_", " ")} · {amount(battle.creatorCost, battle.currency)} cost
                            </p>
                          </TableCell>
                          <TableCell><Outcome row={row} /></TableCell>
                          <TableCell className="text-right">
                            <Profit row={row} />
                            <span className="block text-xs font-normal text-muted-foreground">
                              {amount(battle.creatorPayout, battle.currency)} payout
                            </span>
                          </TableCell>
                          <TableCell>
                            <ControlBadge row={row} />
                            <p className="mt-1 text-xs text-muted-foreground">
                              {row.selection?.requestedTarget
                                ? `Requested ${row.selection.requestedTarget}`
                                : row.selection ? "No requested outcome" : "No monitor record"}
                            </p>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            {new Date(battle.createdAt).toLocaleString()}
                          </TableCell>
                          <TableCell>
                            <Link
                              href={`/users/${battle.creatorUserId}`}
                              aria-label="Open creator"
                              className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
                            >
                              <ArrowUpRight className="size-4" />
                            </Link>
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
