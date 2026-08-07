import {
  CalendarClock,
  CircleDollarSign,
  Crosshair,
  Sparkles,
  Target,
  Trophy,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import {
  formatKenoProbability,
  getKenoHitProbability,
} from "@/lib/keno/payouts";
import type { KenoGameDetails } from "./user-tabs-types";

const RISK_STYLES: Record<
  KenoGameDetails["risk"],
  { label: string; className: string; dot: string }
> = {
  low: {
    label: "Low risk",
    className:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  medium: {
    label: "Medium risk",
    className:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  high: {
    label: "High risk",
    className:
      "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    dot: "bg-rose-500",
  },
};

function formatMultiplier(value: number): string {
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  })}×`;
}

function Detail({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-background px-3 py-2.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate text-sm font-semibold tabular-nums",
          className,
        )}
        title={value}
      >
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
  const risk = RISK_STYLES[game.risk];
  const outcomeLabel =
    playerResult > 0
      ? "Player won"
      : playerResult < 0
        ? "Player lost"
        : "Break even";
  const recordComplete =
    game.selectedNumbers.length >= 1 &&
    game.selectedNumbers.length <= 10 &&
    game.drawnNumbers.length === 10 &&
    computedHits === game.hits;

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="border-b bg-muted/25 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary shadow-sm">
              <Crosshair className="size-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold leading-tight">
                Keno round
              </h3>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarClock className="size-3.5" />
                {formatDateTime(game.createdAt)}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge
              variant="outline"
              className={cn("gap-2 px-2.5 py-1 text-xs", risk.className)}
            >
              <span className={cn("size-2 rounded-full", risk.dot)} />
              {risk.label}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "gap-1.5 px-2.5 py-1 text-xs",
                playerResult > 0
                  ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                  : playerResult < 0
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "border-border bg-background text-muted-foreground",
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
        </div>
      </div>

      <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">Round board</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {game.selectedNumbers.length} picked · 10 drawn · {game.hits}{" "}
                hit{game.hits === 1 ? "" : "s"}
              </p>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Player-facing numbers 1–40
            </p>
          </div>

          <div
            className="grid grid-cols-8 gap-1.5 rounded-xl border bg-muted/15 p-2 sm:gap-2 sm:p-3"
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
                    "relative flex aspect-square min-w-0 items-center justify-center rounded-md border bg-background text-[11px] font-semibold tabular-nums sm:rounded-lg sm:text-sm",
                    wasHit &&
                      "z-10 scale-[1.04] border-emerald-500/70 bg-emerald-500/20 text-emerald-800 shadow-sm ring-2 ring-emerald-500/20 dark:text-emerald-200",
                    wasSelected &&
                      !wasDrawn &&
                      "border-blue-500/60 bg-blue-500/15 text-blue-700 dark:text-blue-300",
                    wasDrawn &&
                      !wasSelected &&
                      "border-red-500/60 bg-red-500/15 text-red-700 dark:text-red-300",
                    !wasSelected &&
                      !wasDrawn &&
                      "border-border/55 text-muted-foreground/70",
                  )}
                >
                  {number + 1}
                  {wasHit && (
                    <Sparkles className="absolute right-0.5 top-0.5 size-2.5 text-emerald-600 sm:size-3 dark:text-emerald-300" />
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm border border-blue-500/60 bg-blue-500/15" />
              Picked
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm border border-red-500/60 bg-red-500/15" />
              Drawn, not picked
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm border border-emerald-500/70 bg-emerald-500/20" />
              Picked + hit
            </span>
          </div>
        </div>

        <aside className="space-y-3">
          <div
            className={cn(
              "flex items-center justify-between gap-3 rounded-lg border px-3 py-2",
              risk.className,
            )}
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em]">
              Risk profile
            </p>
            <p className="text-sm font-bold capitalize">{game.risk}</p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Detail label="Bet" value={formatCurrency(game.betAmount)} />
            <Detail
              label="Payout"
              value={formatCurrency(game.wonAmount)}
              className={
                game.wonAmount > 0
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground"
              }
            />
            <Detail
              label="Player net"
              value={`${playerResult > 0 ? "+" : playerResult < 0 ? "−" : ""}${formatCurrency(Math.abs(playerResult))}`}
              className={
                playerResult > 0
                  ? "text-rose-600 dark:text-rose-400"
                  : playerResult < 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground"
              }
            />
            <Detail
              label="House result"
              value={`${houseResult > 0 ? "+" : houseResult < 0 ? "−" : ""}${formatCurrency(Math.abs(houseResult))}`}
              className={
                houseResult > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : houseResult < 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground"
              }
            />
          </div>

          <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
              <CircleDollarSign className="size-4 text-muted-foreground" />
              Result details
            </div>
            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Picks / hits</dt>
                <dd className="font-semibold tabular-nums">
                  {game.selectedNumbers.length} / {game.hits}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Multiplier</dt>
                <dd className="font-semibold tabular-nums">
                  {formatMultiplier(game.resultMultiplier)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">
                  Exact {game.hits}-hit chance
                </dt>
                <dd className="font-semibold tabular-nums text-cyan-600 dark:text-cyan-400">
                  {formatKenoProbability(hitProbability)}
                </dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>

      {!recordComplete && (
        <p className="mx-4 mb-4 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 sm:mx-5 sm:mb-5 dark:text-amber-300">
          This stored game record is incomplete or its recorded hit count
          differs from the tile intersection. The board shows only the
          positions available in the database.
        </p>
      )}

      <div className="grid gap-1 border-t bg-muted/15 px-4 py-3 font-mono text-[10px] text-muted-foreground sm:grid-cols-2 sm:px-5">
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
    </section>
  );
}
