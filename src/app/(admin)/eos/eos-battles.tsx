"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  CircleDollarSign,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import { toast } from "sonner";

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
type ControlFilter = "all" | "controlled" | "random" | "legacy" | "missing";

function amount(value: number | null, currency: string) {
  if (value === null) return "—";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)} ${currency}`;
}

function controlState(row: BattleData["rows"][number]): ControlFilter {
  const selection = row.selection;
  if (!selection) return "missing";
  if (!selection.auditAvailable) return "legacy";
  return selection.configured ? "controlled" : "random";
}

function ControlBadge({ row }: { row: BattleData["rows"][number] }) {
  const selection = row.selection;
  if (!selection) return <Badge variant="destructive">Not recorded</Badge>;
  if (!selection.auditAvailable) {
    return (
      <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
        {selection.configured ? "Control active · legacy" : "Random · legacy"}
      </Badge>
    );
  }
  if (!selection.configured) return <Badge variant="outline">No config · random</Badge>;
  if (selection.fallbackReason) return <Badge variant="destructive">Config active · fallback</Badge>;
  return <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">Config active · applied</Badge>;
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
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader className="border-b bg-muted/20">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="size-4 text-primary" />Latest EOS battles
              </CardTitle>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                Latest 50 creator battles with an EOS block. Outcome means whether the creator&apos;s
                team won. Profit means creator payout minus their paid entry and sponsorship cost.
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={refresh}>
              {isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          <div className="grid gap-2 sm:grid-cols-4">
            {[
              [Activity, "Loaded battles", data?.rows.length ?? 0],
              [ShieldCheck, "Config applied", controlled],
              [ShieldQuestion, "Decision missing", missing],
              [CircleDollarSign, "Group battles", groupBattles],
            ].map(([Icon, label, value]) => {
              const MetricIcon = Icon as typeof Activity;
              return (
                <div key={label as string} className="rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center gap-2 text-muted-foreground"><MetricIcon className="size-3.5" /><span className="text-[10px] font-medium uppercase tracking-wide">{label as string}</span></div>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{value as number}</p>
                </div>
              );
            })}
          </div>

          <div className="rounded-lg border border-blue-500/25 bg-blue-500/5 p-3 text-xs leading-5 text-muted-foreground">
            <span className="font-semibold text-foreground">Group mode:</span> everyone belongs to
            team 1, so the creator outcome is always a win. A requested loss cannot exist; EOS
            falls back to the candidate with the lowest creator profit among the five blocks.
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder="Search creator or battle ID" />
            </div>
            <Select value={controlFilter} onValueChange={(value) => value && setControlFilter(value as ControlFilter)}>
              <SelectTrigger className="w-full sm:w-52" aria-label="Filter EOS control status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All control states</SelectItem>
                <SelectItem value="controlled">Config applied</SelectItem>
                <SelectItem value="random">No config · random</SelectItem>
                <SelectItem value="legacy">Legacy record</SelectItem>
                <SelectItem value="missing">Decision missing</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {!data && isPending ? (
            <div className="flex min-h-52 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading EOS battles</div>
          ) : rows.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">No battles match these filters.</div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table className="min-w-[1040px]">
                <TableHeader><TableRow>
                  <TableHead>Creator</TableHead><TableHead>Mode</TableHead><TableHead>Outcome</TableHead>
                  <TableHead className="text-right">Creator profit</TableHead><TableHead className="text-right">Cost / payout</TableHead>
                  <TableHead>EOS control</TableHead><TableHead>Time</TableHead><TableHead><span className="sr-only">Open</span></TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const battle = row.battle;
                    return (
                      <TableRow key={battle.battleId}>
                        <TableCell><p className="max-w-44 truncate font-medium">{battle.creatorUsername ?? "Unnamed creator"}</p><p className="max-w-44 truncate font-mono text-[10px] text-muted-foreground">{battle.creatorUserId}</p></TableCell>
                        <TableCell><Badge variant="outline" className="capitalize">{battle.mode.replaceAll("_", " ")}</Badge></TableCell>
                        <TableCell><span className={cn("font-semibold uppercase", battle.creatorWonBattle === true && "text-emerald-600 dark:text-emerald-400", battle.creatorWonBattle === false && "text-destructive")}>{battle.creatorWonBattle === null ? "Pending" : battle.creatorWonBattle ? "Win" : "Loss"}</span><span className="block text-[10px] text-muted-foreground">team {battle.creatorTeam}{battle.winnerTeam === null ? "" : ` · winner ${battle.winnerTeam}`}</span></TableCell>
                        <TableCell className={cn("text-right font-semibold tabular-nums", (battle.creatorProfitLoss ?? 0) > 0 && "text-destructive", (battle.creatorProfitLoss ?? 0) < 0 && "text-emerald-600 dark:text-emerald-400")}>{amount(battle.creatorProfitLoss, battle.currency)}<span className="block text-[10px] font-normal text-muted-foreground">{battle.creatorMultiplier?.toFixed(2) ?? "—"}× payout multiplier</span></TableCell>
                        <TableCell className="text-right text-xs tabular-nums"><span>{amount(battle.creatorCost, battle.currency)} cost</span><span className="block text-muted-foreground">{amount(battle.creatorPayout, battle.currency)} payout</span></TableCell>
                        <TableCell><ControlBadge row={row} /><p className="mt-1 text-[10px] text-muted-foreground">{row.selection?.requestedTarget ? `requested ${row.selection.requestedTarget}` : row.selection ? "no requested outcome" : "no monitor record"}</p></TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(battle.createdAt).toLocaleString()}</TableCell>
                        <TableCell><Link href={`/users/${battle.creatorUserId}`} aria-label="Open creator" className={buttonVariants({ size: "icon-sm", variant: "ghost" })}><ArrowUpRight className="size-4" /></Link></TableCell>
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
