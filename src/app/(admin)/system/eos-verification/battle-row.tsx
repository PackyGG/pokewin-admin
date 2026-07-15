"use client";

import { useState, useTransition } from "react";
import {
  ChevronRight,
  Hash,
  Trophy,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Play,
  ListChecks,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { BorrowBadge } from "@/components/borrow-badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import type { EosBattleSummary } from "@/lib/queries/eos-verification";
import {
  revealBattleEosVerification,
  simulateBattleOutcomeForBlock,
  simulateAllBlockOutcomes,
  type BattleEosVerification,
  type BlockSimulationResult,
} from "./actions";

type BlockSimState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; result: Extract<BlockSimulationResult, { status: "ok" }> };

const BATTLE_MODE_LABELS: Record<string, string> = {
  normal: "Normal",
  jackpot: "Jackpot",
  group: "Group",
  hp_rush: "HP Rush",
  lowest: "Lowest",
};

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

export function BattleRow({ battle }: { battle: EosBattleSummary }) {
  const [isOpen, setIsOpen] = useState(false);
  const [detail, setDetail] = useState<BattleEosVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [simResults, setSimResults] = useState<Record<number, BlockSimState>>({});
  const [isSolvingAll, setIsSolvingAll] = useState(false);

  const handleSolveAll = (blocks: { blockNum: number; status: string; blockHash?: string }[]) => {
    const solvable = blocks.filter(
      (b): b is { blockNum: number; status: string; blockHash: string } =>
        b.status === "ok" && typeof b.blockHash === "string",
    );
    if (solvable.length === 0) return;

    setIsSolvingAll(true);
    setSimResults((prev) => {
      const next = { ...prev };
      for (const b of solvable) next[b.blockNum] = { status: "loading" };
      return next;
    });

    void (async () => {
      try {
        const results = await simulateAllBlockOutcomes(
          battle.id,
          solvable.map((b) => ({ blockNum: b.blockNum, blockHash: b.blockHash })),
        );
        setSimResults((prev) => {
          const next = { ...prev };
          for (const [blockNumStr, res] of Object.entries(results)) {
            next[Number(blockNumStr)] =
              res.status === "error"
                ? { status: "error", message: res.error }
                : { status: "ok", result: res };
          }
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to simulate.";
        setSimResults((prev) => {
          const next = { ...prev };
          for (const b of solvable) next[b.blockNum] = { status: "error", message };
          return next;
        });
      } finally {
        setIsSolvingAll(false);
      }
    })();
  };

  const handleSimulate = (blockNum: number, blockHash: string) => {
    setSimResults((prev) => ({ ...prev, [blockNum]: { status: "loading" } }));
    void (async () => {
      try {
        const res = await simulateBattleOutcomeForBlock(battle.id, blockHash);
        setSimResults((prev) => ({
          ...prev,
          [blockNum]:
            res.status === "error"
              ? { status: "error", message: res.error }
              : { status: "ok", result: res },
        }));
      } catch (err) {
        setSimResults((prev) => ({
          ...prev,
          [blockNum]: {
            status: "error",
            message: err instanceof Error ? err.message : "Failed to simulate.",
          },
        }));
      }
    })();
  };

  const handleToggle = () => {
    const next = !isOpen;
    setIsOpen(next);
    if (next && !detail && !error) {
      startTransition(async () => {
        try {
          const result = await revealBattleEosVerification(battle.id);
          if (!result) {
            setError("Battle not found.");
            return;
          }
          setDetail(result);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to load.");
        }
      });
    }
  };

  return (
    <div className="rounded-xl border bg-card">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            isOpen && "rotate-90",
          )}
        />
        <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
          {BATTLE_MODE_LABELS[battle.mode] ?? battle.mode}
        </Badge>
        <span className="text-sm font-semibold tabular-nums">
          {formatCurrency(battle.betAmount)}
        </span>
        <span className="text-xs text-muted-foreground">
          {battle.teams}×{battle.playersPerTeam} · {battle.participantCount} players
        </span>
        <span className="text-xs font-medium tabular-nums text-muted-foreground">
          {formatCurrency(battle.totalPotUsd)} total
        </span>
        <BorrowBadge
          percent={battle.borrowPercentage}
          amountUsd={battle.borrowedAmountUsd}
          size="sm"
        />
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-foreground">
              {battle.creatorUsername ?? "—"}
            </span>
            {battle.creatorWon !== null && (
              <Badge
                variant="outline"
                className={cn(
                  "h-4 px-1.5 text-[9px] uppercase",
                  battle.creatorWon
                    ? "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
                    : "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
                )}
              >
                {battle.creatorWon ? "Won" : "Lost"}
              </Badge>
            )}
          </span>
          <span>{formatRelative(battle.createdAt)}</span>
        </span>
      </button>

      {isOpen && (
        <div className="space-y-4 border-t px-4 py-4">
          {isPending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Fetching the EOS block plus the 4 before it...
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <p className="text-xs text-amber-700 dark:text-amber-300">{error}</p>
            </div>
          )}

          {detail && (
            <>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  <Hash className="size-3.5" />
                  EOS block hash
                </div>
                {detail.eosBlockHash ? (
                  <>
                    <code className="block break-all rounded-md bg-muted px-2 py-1.5 text-xs">
                      {detail.eosBlockHash}
                    </code>
                    {detail.blockHistory?.status === "error" ? (
                      <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2">
                        <XCircle className="mt-0.5 size-3.5 shrink-0 text-rose-500" />
                        <p className="text-xs text-rose-700 dark:text-rose-300">
                          {detail.blockHistory.error}
                        </p>
                      </div>
                    ) : detail.blockHistory?.status === "ok" ? (
                      <>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                          <span className="text-muted-foreground">
                            Confirmed via {stripProtocol(detail.blockHistory.endpoint)} ·
                            block plus the 4 before it
                          </span>
                          <button
                            type="button"
                            onClick={() => handleSolveAll(detail.blockHistory!.status === "ok" ? detail.blockHistory!.blocks : [])}
                            disabled={isSolvingAll}
                            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[10px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                          >
                            {isSolvingAll ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <ListChecks className="size-3" />
                            )}
                            Solve all
                          </button>
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          &quot;Show result&quot; recomputes the battle&apos;s outcome as if that
                          block had been used, with the real server seed, participants, and
                          mode — pack odds use today&apos;s live pack config.
                        </p>
                        <div className="mt-2 space-y-1.5">
                          {detail.blockHistory.blocks.map((block, i) => (
                            <div key={block.blockNum} className="space-y-1.5">
                              <div
                                className={cn(
                                  "flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-[11px]",
                                  i === 0 && "border-cyan-500/40 bg-cyan-500/5",
                                )}
                              >
                                {block.status === "ok" ? (
                                  <CheckCircle2 className="size-3 shrink-0 text-emerald-500" />
                                ) : (
                                  <XCircle className="size-3 shrink-0 text-rose-500" />
                                )}
                                <span className="shrink-0 font-semibold tabular-nums">
                                  #{block.blockNum}
                                </span>
                                {i === 0 && (
                                  <Badge
                                    variant="outline"
                                    className="h-4 shrink-0 px-1 text-[9px] uppercase"
                                  >
                                    Battle block
                                  </Badge>
                                )}
                                {block.status === "ok" ? (
                                  <>
                                    <code
                                      className="min-w-0 flex-1 truncate text-muted-foreground"
                                      title={block.blockHash}
                                    >
                                      {block.blockHash}
                                    </code>
                                    <span className="shrink-0 text-muted-foreground">
                                      {block.producer}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => handleSimulate(block.blockNum, block.blockHash)}
                                      disabled={simResults[block.blockNum]?.status === "loading"}
                                      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                    >
                                      {simResults[block.blockNum]?.status === "loading" ? (
                                        <Loader2 className="size-3 animate-spin" />
                                      ) : (
                                        <Play className="size-3" />
                                      )}
                                      Show result
                                    </button>
                                  </>
                                ) : (
                                  <span
                                    className="ml-auto truncate text-muted-foreground"
                                    title={block.error}
                                  >
                                    {block.error}
                                  </span>
                                )}
                              </div>
                              {simResults[block.blockNum] && (
                                <BlockSimPanel
                                  state={simResults[block.blockNum]!}
                                  recordedWinnerTeam={battle.winnerTeam}
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No EOS block recorded for this battle.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const SCORE_UNIT_LABEL: Record<string, (value: number) => string> = {
  value: (value) => formatCurrency(value),
  hp: (value) => `${value} HP`,
  points: (value) => `${value} pt${value === 1 ? "" : "s"}`,
};

function BlockSimPanel({
  state,
  recordedWinnerTeam,
}: {
  state: BlockSimState;
  recordedWinnerTeam: number | null;
}) {
  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Recomputing this block&apos;s outcome...
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        <p className="text-[11px] text-amber-700 dark:text-amber-300">{state.message}</p>
      </div>
    );
  }

  const { outcome, creatorWon } = state.result;
  const matchesRecorded =
    recordedWinnerTeam !== null && outcome.winnerTeam !== null
      ? outcome.winnerTeam === recordedWinnerTeam
      : null;
  const scoreLabel = SCORE_UNIT_LABEL[outcome.scoreUnit];
  const scoreEntries = Object.entries(outcome.teamScores);

  return (
    <div className="space-y-1.5 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <Trophy className="size-3.5 text-yellow-500" />
        <span className="font-semibold">
          {outcome.winnerTeam !== null
            ? `Team ${outcome.winnerTeam} would win`
            : "No winner determined"}
        </span>
        {creatorWon !== null && (
          <Badge
            variant="outline"
            className={cn(
              "h-4 px-1.5 text-[9px] uppercase",
              creatorWon
                ? "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
                : "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
            )}
          >
            Creator {creatorWon ? "would win" : "would lose"}
          </Badge>
        )}
        {outcome.usedTiebreaker && (
          <Badge variant="outline" className="h-4 px-1 text-[9px] uppercase">
            Tiebreaker roll
          </Badge>
        )}
        {matchesRecorded !== null && (
          <Badge
            variant="outline"
            className={cn(
              "h-4 px-1 text-[9px] uppercase",
              matchesRecorded
                ? "border-sky-500/30 text-sky-600 dark:text-sky-400"
                : "border-amber-500/30 text-amber-600 dark:text-amber-400",
            )}
          >
            {matchesRecorded ? "Matches recorded result" : "Differs from recorded result"}
          </Badge>
        )}
      </div>
      {scoreLabel && scoreEntries.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {scoreEntries.map(([team, value]) => (
            <span key={team}>
              Team {team}: {scoreLabel(value)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
