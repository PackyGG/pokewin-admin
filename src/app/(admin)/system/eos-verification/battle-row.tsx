"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  ChevronRight,
  Hash,
  Trophy,
  Bot,
  User as UserIcon,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import type { EosBattleSummary } from "@/lib/queries/eos-verification";
import {
  revealBattleEosVerification,
  type BattleEosVerification,
} from "./actions";

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
        {battle.winnerTeam !== null && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Trophy className="size-3.5 text-yellow-500" />
            Team {battle.winnerTeam} won
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span>by {battle.creatorUsername ?? "—"}</span>
          <span>{formatRelative(battle.createdAt)}</span>
        </span>
      </button>

      {isOpen && (
        <div className="space-y-4 border-t px-4 py-4">
          {isPending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Fetching participants and the EOS block plus the 4 before it...
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
                        <div className="flex items-center gap-1.5 text-xs">
                          <CheckCircle2 className="size-3.5 text-emerald-500" />
                          <span className="text-muted-foreground">
                            Confirmed via {stripProtocol(detail.blockHistory.endpoint)} ·
                            block plus the 4 before it
                          </span>
                        </div>
                        <div className="mt-2 space-y-1">
                          {detail.blockHistory.blocks.map((block, i) => (
                            <div
                              key={block.blockNum}
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
                                  <span className="ml-auto shrink-0 text-muted-foreground">
                                    {block.producer}
                                  </span>
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

              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground">
                  Participants ({detail.participants.length})
                </div>
                <div className="divide-y rounded-md border">
                  {detail.participants.map((p) => (
                    <div
                      key={p.id}
                      className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
                    >
                      {p.isBot ? (
                        <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <UserIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="shrink-0 text-muted-foreground">
                        Team {p.teamNumber} · #{p.teamPosition}
                      </span>
                      {p.isBot || !p.userId ? (
                        <span className="font-medium">
                          {p.username ?? "Unknown"}
                          {p.isBot && (
                            <Badge
                              variant="outline"
                              className="ml-1.5 h-4 px-1 text-[9px] uppercase"
                            >
                              Bot
                            </Badge>
                          )}
                        </span>
                      ) : (
                        <Link
                          href={`/users/${p.userId}`}
                          className="font-medium hover:underline"
                        >
                          {p.username ?? p.userId.slice(0, 8)}
                        </Link>
                      )}
                      <code
                        className="ml-auto max-w-[280px] truncate rounded bg-muted px-1.5 py-0.5 text-[10px]"
                        title={p.clientSeed}
                      >
                        {p.clientSeed}
                      </code>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
