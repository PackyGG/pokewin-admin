import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, Settings2, Ticket, Trophy, Users, Wallet } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { safeQuery } from "@/lib/errors/safe-query";
import { FadeIn } from "@/components/fade-in";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  formatCurrency,
  formatDateTime,
  formatNumber,
} from "@/lib/utils/format";
import {
  CHAT_RAFFLE_PHASE_COLOR,
  CHAT_RAFFLE_PHASE_LABEL,
  describeScoring,
} from "@/lib/chat-raffle/config";
import {
  getChatRaffleRound,
  getRoundAdjustments,
  getRoundEntries,
} from "@/lib/chat-raffle/rounds";
import { PayPrizeDialog } from "../chat-raffle-dialogs";

export const metadata = { title: "Chat Raffle round" };

const DETAIL_TIMEOUT_MS = 10_000;

const POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  2: "bg-zinc-400/15 text-zinc-500 dark:text-zinc-400 border-zinc-400/30",
  3: "bg-amber-700/15 text-amber-700 dark:text-amber-500 border-amber-700/30",
};

/**
 * A single round, as it was decided.
 *
 * Everything here is the FROZEN record — the entries snapshot written at draw
 * time, not a re-score. That is the whole point: re-running the live scorer
 * later would return different numbers the moment a moderator deletes an old
 * message, so a settled round must never be recomputed.
 */
export default async function ChatRaffleRoundPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("/chat-raffle");
  const { id } = await params;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Trophy}
          accent="cyan"
          title="Raffle round"
          subtitle="The frozen draw record"
          backHref="/chat-raffle"
        />
      </PageHero>

      <Suspense fallback={<RoundDetailSkeleton />}>
        <RoundDetail id={id} />
      </Suspense>
    </div>
  );
}

async function RoundDetail({ id }: { id: string }) {
  const round = await getChatRaffleRound(id);
  if (!round) notFound();

  const [entries, adjustments] = await Promise.all([
    safeQuery(
      () => getRoundEntries(round.id),
      [],
      "chat-raffle.entries",
      DETAIL_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRoundAdjustments(round.id),
      [],
      "chat-raffle.adjustment-log",
      DETAIL_TIMEOUT_MS,
    ),
  ]);

  return (
    <FadeIn className="space-y-6">
      <SectionHeading
        icon={Trophy}
        title={
          <>
            {round.name}
            <Badge
              variant="outline"
              className={cn(
                "h-5 px-1.5 text-[10px] uppercase",
                CHAT_RAFFLE_PHASE_COLOR[round.phase],
              )}
            >
              {CHAT_RAFFLE_PHASE_LABEL[round.phase]}
            </Badge>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Prize pool"
          value={formatCurrency(round.prizePoolUsd)}
          sub={`${round.prizes.length} ${round.prizes.length === 1 ? "place" : "places"}`}
          icon={Wallet}
          accent="rose"
        />
        <KpiTile
          label="Entrants"
          value={formatNumber(round.entrantsAtDraw ?? entries.data.length)}
          sub="at draw time"
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Tickets"
          value={formatNumber(round.ticketsAtDraw ?? 0)}
          sub="in the pool"
          icon={Ticket}
          accent="cyan"
        />
        <KpiTile
          label="Drawn"
          value={round.drawnAt ? formatDateTime(new Date(round.drawnAt)) : "—"}
          sub={`${formatDateTime(new Date(round.startsAt))} → ${formatDateTime(new Date(round.endsAt))}`}
          icon={Clock}
          accent="amber"
        />
      </div>

      <div className="rounded-2xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold">Scoring used</span>
          <span className="text-xs text-muted-foreground">
            {describeScoring(round.scoring)}
          </span>
        </div>
        {round.drawSeed && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Draw seed{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              {round.drawSeed}
            </code>{" "}
            — winner N = HMAC-SHA256(seed, &quot;{round.id}:N&quot;) mod tickets,
            against the snapshot below.
          </p>
        )}
        {round.notes && (
          <p className="mt-2 text-xs text-muted-foreground">{round.notes}</p>
        )}
      </div>

      {/* ─── Winners ─────────────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading icon={Trophy} title="Winners" />
        <div className="overflow-hidden rounded-2xl border bg-card">
          {round.prizes.map((prize) => (
            <div
              key={prize.id}
              className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0"
            >
              <div
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-bold",
                  POSITION_COLORS[prize.position] ??
                    "bg-muted text-muted-foreground border-border",
                )}
              >
                #{prize.position}
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                {prize.winnerUserId ? (
                  <Link
                    href={`/users/${prize.winnerUserId}`}
                    className="truncate font-semibold hover:underline"
                  >
                    {prize.winnerUsername ?? prize.winnerUserId.slice(0, 8)}
                  </Link>
                ) : (
                  <span className="text-sm text-muted-foreground">Not drawn</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {prize.label ? `${prize.label} · ` : ""}
                  {prize.winnerTickets !== null
                    ? `${formatNumber(prize.winnerTickets)} tickets`
                    : "—"}
                  {prize.paidAt
                    ? ` · paid ${formatDateTime(new Date(prize.paidAt))}`
                    : ""}
                </span>
              </div>
              {/* House POV: a prize is money leaving the house to a player. */}
              <span className="shrink-0 tabular-nums text-sm font-semibold text-rose-600 dark:text-rose-400">
                {formatCurrency(prize.amountUsd)}
              </span>
              {prize.winnerUserId &&
                (prize.paidAt ? (
                  <Badge
                    variant="outline"
                    className="h-5 shrink-0 border-emerald-500/30 bg-emerald-500/15 px-1.5 text-[10px] text-emerald-600 uppercase dark:text-emerald-400"
                  >
                    Paid
                  </Badge>
                ) : (
                  <PayPrizeDialog
                    prizeId={prize.id}
                    position={prize.position}
                    amountUsd={prize.amountUsd}
                    winnerUsername={prize.winnerUsername}
                    roundName={round.name}
                  />
                ))}
            </div>
          ))}
        </div>
      </div>

      {/* ─── Frozen snapshot ─────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading icon={Ticket} title="Ticket snapshot" />
        {entries.data.length === 0 ? (
          <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            No snapshot — this round was never drawn.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border bg-card">
            {entries.data.map((entry) => (
              <div
                key={entry.userId}
                className="flex items-center gap-3 border-b px-4 py-2 last:border-b-0"
              >
                <span className="w-8 shrink-0 text-xs font-semibold text-muted-foreground">
                  #{entry.position}
                </span>
                <Link
                  href={`/users/${entry.userId}`}
                  className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                >
                  {entry.username ?? entry.userId.slice(0, 8)}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatNumber(entry.messageCount)} msgs
                </span>
                {entry.adjustmentPoints !== 0 && (
                  <Badge
                    variant="outline"
                    className="h-4 shrink-0 px-1 text-[9px] tabular-nums"
                  >
                    {entry.adjustmentPoints > 0 ? "+" : ""}
                    {entry.adjustmentPoints} adj
                  </Badge>
                )}
                <span className="w-20 shrink-0 text-right tabular-nums text-sm font-medium">
                  {formatNumber(entry.tickets)}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    tix
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Manual corrections ──────────────────────────────────── */}
      {adjustments.data.length > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={Settings2} title="Manual point adjustments" />
          <div className="overflow-hidden rounded-2xl border bg-card">
            {adjustments.data.map((adj) => (
              <div
                key={adj.id}
                className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
              >
                <Link
                  href={`/users/${adj.userId}`}
                  className="shrink-0 text-sm font-medium hover:underline"
                >
                  {adj.userId.slice(0, 8)}
                </Link>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {adj.reason}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {adj.adminUsername ?? "—"} ·{" "}
                  {formatDateTime(new Date(adj.createdAt))}
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-sm font-semibold">
                  {adj.points > 0 ? "+" : ""}
                  {formatNumber(adj.points)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </FadeIn>
  );
}

function RoundDetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-6 w-56 rounded" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-2xl" />
    </div>
  );
}
