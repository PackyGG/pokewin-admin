import { Crosshair, Sparkles, Target, Trophy } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import {
  formatKenoProbability,
  getKenoHitProbability,
} from "@/lib/keno/payouts";
import type { KenoGameDetails } from "./user-tabs-types";

function formatMultiplier(value: number): string {
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  })}×`;
}

function Metric({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/55 p-2.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-1 text-sm font-semibold tabular-nums", className)}>
        {value}
      </p>
    </div>
  );
}

export function KenoGameReplay({ game }: { game: KenoGameDetails }) {
  const selected = new Set(game.selectedNumbers);
  const drawn = new Set(game.drawnNumbers);
  const computedHits = game.selectedNumbers.filter((number) =>
    drawn.has(number),
  ).length;
  const hitProbability = getKenoHitProbability(
    game.selectedNumbers.length,
    game.hits,
  );
  const houseResult = game.betAmount - game.wonAmount;
  const playerResult = game.wonAmount - game.betAmount;
  const outcomeLabel =
    playerResult > 0
      ? "Player profited"
      : playerResult < 0
        ? "Player lost"
        : "Broke even";
  const recordComplete =
    game.selectedNumbers.length >= 1 &&
    game.selectedNumbers.length <= 10 &&
    game.drawnNumbers.length === 10 &&
    computedHits === game.hits;

  return (
    <section className="overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-background to-background shadow-sm">
      <div className="border-b border-border/60 px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
              <Crosshair className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <h3 className="text-sm font-semibold">Keno game replay</h3>
                <Badge variant="outline" className="capitalize">
                  {game.risk} risk
                </Badge>
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {formatDateTime(game.createdAt)} · displayed as tiles 1–40
              </p>
            </div>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "gap-1.5",
              playerResult > 0
                ? "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
                : playerResult < 0
                  ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "border-border bg-muted text-muted-foreground",
            )}
          >
            {playerResult > 0 ? (
              <Trophy className="size-3.5" />
            ) : (
              <Target className="size-3.5" />
            )}
            {outcomeLabel}
          </Badge>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
          <Metric label="Bet" value={formatCurrency(game.betAmount)} />
          <Metric label="Picks" value={String(game.selectedNumbers.length)} />
          <Metric
            label="Hits"
            value={`${game.hits} / ${game.selectedNumbers.length}`}
          />
          <Metric
            label="Multiplier"
            value={formatMultiplier(game.resultMultiplier)}
          />
          <Metric
            label={`Chance of ${game.hits} hits`}
            value={formatKenoProbability(hitProbability)}
            className="text-cyan-600 dark:text-cyan-400"
          />
          <Metric
            label="Player payout"
            value={formatCurrency(game.wonAmount)}
            className={
              game.wonAmount > 0
                ? "text-rose-600 dark:text-rose-400"
                : "text-muted-foreground"
            }
          />
          <Metric
            label="House result"
            value={`${houseResult >= 0 ? "+" : "−"}${formatCurrency(Math.abs(houseResult))}`}
            className={
              houseResult >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400"
            }
          />
        </div>
      </div>

      <div className="p-3 sm:p-4">
        <div
          className="grid grid-cols-8 gap-1.5 sm:gap-2"
          aria-label="Keno board showing selected and drawn tiles"
        >
          {Array.from({ length: 40 }, (_, number) => {
            const wasSelected = selected.has(number);
            const wasDrawn = drawn.has(number);
            const wasHit = wasSelected && wasDrawn;
            const label = wasHit
              ? "picked and hit"
              : wasSelected
                ? "picked and missed"
                : wasDrawn
                  ? "drawn"
                  : "not selected";

            return (
              <div
                key={number}
                role="img"
                aria-label={`Tile ${number + 1}: ${label}`}
                title={`Tile ${number + 1} · stored position ${number} · ${label}`}
                className={cn(
                  "relative flex aspect-square min-w-0 items-center justify-center rounded-md border text-[11px] font-semibold tabular-nums transition-transform sm:rounded-lg sm:text-sm",
                  wasHit &&
                    "z-10 scale-[1.04] border-rose-400/60 bg-rose-500/20 text-rose-700 shadow-sm ring-1 ring-rose-500/20 dark:text-rose-300",
                  wasSelected &&
                    !wasDrawn &&
                    "border-emerald-500/45 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
                  wasDrawn &&
                    !wasSelected &&
                    "border-blue-500/40 bg-blue-500/12 text-blue-700 dark:text-blue-300",
                  !wasSelected &&
                    !wasDrawn &&
                    "border-border/55 bg-muted/25 text-muted-foreground/75",
                )}
              >
                {number + 1}
                {wasHit && (
                  <Sparkles className="absolute right-0.5 top-0.5 size-2.5 text-rose-500 sm:size-3" />
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm border border-rose-500/60 bg-rose-500/20" />
            Picked + hit
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm border border-emerald-500/50 bg-emerald-500/15" />
            Picked + missed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm border border-blue-500/50 bg-blue-500/15" />
            Drawn
          </span>
        </div>

        {!recordComplete && (
          <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            This stored game record is incomplete or its recorded hit count
            differs from the tile intersection. The board shows only the
            positions available in the database.
          </p>
        )}

        <div className="mt-3 grid gap-1 border-t border-border/60 pt-3 font-mono text-[10px] text-muted-foreground sm:grid-cols-2">
          <span className="truncate" title={game.id}>
            Game {game.id}
          </span>
          <span
            className="truncate sm:text-right"
            title={game.betLedgerTxId ?? undefined}
          >
            Bet TX {game.betLedgerTxId ?? "not recorded"}
          </span>
          {game.payoutLedgerTxId && (
            <span
              className="truncate sm:col-start-2 sm:text-right"
              title={game.payoutLedgerTxId}
            >
              Payout TX {game.payoutLedgerTxId}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
