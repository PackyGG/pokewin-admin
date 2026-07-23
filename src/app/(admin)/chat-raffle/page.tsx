import { Suspense } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Clock,
  Dices,
  History,
  MessageSquare,
  Ticket,
  Trophy,
  Users,
  Wallet,
} from "lucide-react";

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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ROLE_COLORS } from "@/lib/constants";
import { formatCurrency, formatDateTime, formatNumber, formatRelative } from "@/lib/utils/format";
import {
  CHAT_RAFFLE_MAX_ENTRIES,
  CHAT_RAFFLE_PHASE_COLOR,
  CHAT_RAFFLE_PHASE_LABEL,
  DEFAULT_CHAT_RAFFLE_SCORING,
  canDrawRound,
  canEditRound,
  describeScoring,
} from "@/lib/chat-raffle/config";
import {
  getActiveChatRaffleRound,
  getChatRaffleRounds,
  getDefaultScoringForNewRound,
  getRoundAdjustmentTotals,
  pickActiveRound,
  type ChatRaffleRoundView,
} from "@/lib/chat-raffle/rounds";
import {
  getChatRaffleStandings,
  type ChatRaffleStanding,
} from "@/lib/chat-raffle/standings";
import {
  AdjustPointsDialog,
  CancelRoundButton,
  DrawRoundButton,
  PayPrizeDialog,
  RoundFormDialog,
} from "./chat-raffle-dialogs";

export const metadata = { title: "Chat Raffle" };

/**
 * Players → Chat Raffle.
 *
 * Chat activity becomes points, points become tickets, and one ticket per
 * prize place is drawn with a stored seed. The whole system lives in the
 * ADMIN DB: rounds, scoring config, manual point corrections, the frozen draw
 * snapshot and the prize ladder. The prod game DB is only READ (scoring the
 * window off `chat_messages`) — the single write is the existing
 * balance-adjustment path when an operator pays a winner. No prod code change.
 *
 * Shell-first: the page paints immediately and both data legs stream in
 * behind their own Suspense boundaries (see loading.tsx for the matching
 * skeletons).
 */

/** Bounded window + a small table, but it heap-fetches every message in the
 *  round — keep the connection-hang guard. */
const STANDINGS_TIMEOUT_MS = 20_000;
const ROUNDS_TIMEOUT_MS = 10_000;

const POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  2: "bg-zinc-400/15 text-zinc-500 dark:text-zinc-400 border-zinc-400/30",
  3: "bg-amber-700/15 text-amber-700 dark:text-amber-500 border-amber-700/30",
};

export default async function ChatRafflePage() {
  await requirePageAccess("/chat-raffle");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Dices}
          accent="cyan"
          title="Chat Raffle"
          subtitle="Chat activity earns tickets — one is drawn per prize place"
        />
      </PageHero>

      <Suspense fallback={<ActiveRoundSkeleton />}>
        <ActiveRoundSection />
      </Suspense>

      <Suspense fallback={<RoundHistorySkeleton />}>
        <RoundHistorySection />
      </Suspense>
    </div>
  );
}

// ─── Active round ───────────────────────────────────────────────────

async function ActiveRoundSection() {
  const roundResult = await safeQuery(
    () => getActiveChatRaffleRound(),
    null,
    "chat-raffle.active-round",
    ROUNDS_TIMEOUT_MS,
  );
  const round = roundResult.data;

  const defaultScoring = await safeQuery(
    () => getDefaultScoringForNewRound(),
    DEFAULT_CHAT_RAFFLE_SCORING,
    "chat-raffle.default-scoring",
    ROUNDS_TIMEOUT_MS,
  );

  if (!round) {
    return (
      <NoActiveRound defaultScoring={defaultScoring.data} />
    );
  }

  const adjustments = await safeQuery(
    () => getRoundAdjustmentTotals(round.id),
    new Map<string, number>(),
    "chat-raffle.adjustments",
    ROUNDS_TIMEOUT_MS,
  );

  const standingsResult = await safeQuery(
    () =>
      getChatRaffleStandings({
        startsAt: new Date(round.startsAt),
        endsAt: new Date(round.endsAt),
        scoring: round.scoring,
        adjustments: adjustments.data,
      }),
    { standings: [], totalTickets: 0, entrants: 0, truncated: false },
    "chat-raffle.standings",
    STANDINGS_TIMEOUT_MS,
  );

  const { standings, totalTickets, entrants, truncated } = standingsResult.data;
  const editable = canEditRound(round.phase);

  return (
    <FadeIn className="space-y-6">
      <SectionHeading
        icon={Dices}
        title={
          <>
            {round.name}
            <Badge
              variant="outline"
              className={cn("h-5 px-1.5 text-[10px] uppercase", CHAT_RAFFLE_PHASE_COLOR[round.phase])}
            >
              {CHAT_RAFFLE_PHASE_LABEL[round.phase]}
            </Badge>
          </>
        }
        action={
          <>
            {editable && (
              <RoundFormDialog
                mode="edit"
                triggerVariant="outline"
                round={{
                  id: round.id,
                  name: round.name,
                  startsAt: round.startsAt,
                  endsAt: round.endsAt,
                  notes: round.notes,
                  scoring: round.scoring,
                  prizes: round.prizes.map((p) => ({
                    position: p.position,
                    amountUsd: p.amountUsd,
                    label: p.label,
                  })),
                }}
              />
            )}
            {editable && (
              <CancelRoundButton roundId={round.id} roundName={round.name} />
            )}
            {canDrawRound(round.phase) && (
              <DrawRoundButton
                roundId={round.id}
                roundName={round.name}
                entrants={entrants}
                totalTickets={totalTickets}
                prizeCount={round.prizes.length}
                disabled={entrants === 0 || truncated}
              />
            )}
            <RoundFormDialog
              mode="create"
              defaultScoring={defaultScoring.data}
              triggerVariant="outline"
            />
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
          value={formatNumber(entrants)}
          sub="qualified so far"
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Tickets"
          value={formatNumber(totalTickets)}
          sub="1 point = 1 ticket"
          icon={Ticket}
          accent="cyan"
        />
        <KpiTile
          label={round.phase === "ready" ? "Closed" : "Ends"}
          value={formatRelative(new Date(round.endsAt))}
          sub={formatDateTime(new Date(round.endsAt))}
          icon={Clock}
          accent="amber"
        />
      </div>

      <div className="rounded-2xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold">Scoring</span>
          <span className="text-xs text-muted-foreground">
            {describeScoring(round.scoring)}
          </span>
        </div>
      </div>

      {standingsResult.error !== null && <QueryFailedNotice />}
      {truncated && <TruncatedNotice />}

      <StandingsTable
        standings={standings}
        totalTickets={totalTickets}
        roundId={round.id}
        adjustable={editable}
        emptyMessage="Nobody has qualified for this round yet."
      />

      {round.prizes.some((p) => p.winnerUserId) && (
        <WinnersPanel round={round} />
      )}
    </FadeIn>
  );
}

/**
 * No open round: show what the current UTC day WOULD score under the default
 * config, so an operator can sanity-check the weights before committing a
 * round to them.
 */
async function NoActiveRound({
  defaultScoring,
}: {
  defaultScoring: typeof DEFAULT_CHAT_RAFFLE_SCORING;
}) {
  const now = new Date();
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  const preview = await safeQuery(
    () =>
      getChatRaffleStandings({
        startsAt: dayStart,
        endsAt: dayEnd,
        scoring: defaultScoring,
      }),
    { standings: [], totalTickets: 0, entrants: 0, truncated: false },
    "chat-raffle.preview",
    STANDINGS_TIMEOUT_MS,
  );

  return (
    <FadeIn className="space-y-6">
      <SectionHeading
        icon={Dices}
        title="No round running"
        action={
          <RoundFormDialog mode="create" defaultScoring={defaultScoring} />
        }
      />

      <div className="rounded-2xl border border-dashed p-6 text-center">
        <Dices className="mx-auto size-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">Start a round to hand out tickets</p>
        <p className="mx-auto mt-1 max-w-lg text-xs text-muted-foreground">
          Below is what today would score under the current default config —
          a dry run, nothing is being counted toward a prize.
        </p>
      </div>

      {preview.error !== null && <QueryFailedNotice />}

      <SectionHeading icon={MessageSquare} title="Today's chat, scored (preview)" />
      <StandingsTable
        standings={preview.data.standings}
        totalTickets={preview.data.totalTickets}
        roundId={null}
        adjustable={false}
        emptyMessage="No chat messages have scored today yet."
      />
    </FadeIn>
  );
}

// ─── Standings ──────────────────────────────────────────────────────

function StandingsTable({
  standings,
  totalTickets,
  roundId,
  adjustable,
  emptyMessage,
}: {
  standings: ChatRaffleStanding[];
  totalTickets: number;
  roundId: string | null;
  adjustable: boolean;
  emptyMessage: string;
}) {
  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Standings</span>
        <span className="text-xs text-muted-foreground">
          {formatNumber(standings.length)}{" "}
          {standings.length === 1 ? "entrant" : "entrants"} ·{" "}
          {formatNumber(totalTickets)} tickets
        </span>
      </div>

      {standings.length === 0 ? (
        <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground">
          <MessageSquare className="size-6" />
          <span className="text-sm">{emptyMessage}</span>
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-md border">
          {standings.map((entry) => {
            const positionColor =
              POSITION_COLORS[entry.position] ??
              "bg-muted text-muted-foreground border-border";
            return (
              <div
                key={entry.userId}
                className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
              >
                <div
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-bold",
                    positionColor,
                  )}
                >
                  {entry.position <= 3 ? (
                    <Trophy className="size-4" />
                  ) : (
                    `#${entry.position}`
                  )}
                </div>

                <Avatar className="size-8 shrink-0">
                  {entry.image && <AvatarImage src={entry.image} />}
                  <AvatarFallback className="text-[11px]">
                    {(entry.username ?? entry.userId).slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>

                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Link
                    href={`/users/${entry.userId}`}
                    className="truncate font-semibold hover:underline"
                  >
                    {entry.username ?? entry.userId.slice(0, 8)}
                  </Link>
                  {entry.role !== "user" && (
                    <Badge
                      variant="outline"
                      className={cn(
                        "h-4 shrink-0 px-1 text-[9px] uppercase",
                        ROLE_COLORS[entry.role],
                      )}
                    >
                      {entry.role}
                    </Badge>
                  )}
                  {entry.adjustmentPoints !== 0 && (
                    <Badge
                      variant="outline"
                      className="h-4 shrink-0 px-1 text-[9px] tabular-nums"
                    >
                      {entry.adjustmentPoints > 0 ? "+" : ""}
                      {entry.adjustmentPoints} adj
                    </Badge>
                  )}
                </div>

                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                  {formatNumber(entry.messageCount)} msgs
                </span>

                <span className="w-16 shrink-0 text-right tabular-nums text-sm font-medium">
                  {formatNumber(entry.tickets)}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    tix
                  </span>
                </span>

                <span className="w-12 shrink-0 text-right tabular-nums text-xs text-muted-foreground">
                  {(entry.winChance * 100).toFixed(1)}%
                </span>

                {adjustable && roundId && (
                  <AdjustPointsDialog
                    roundId={roundId}
                    userId={entry.userId}
                    username={entry.username}
                    currentPoints={entry.points}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Winners + payouts ──────────────────────────────────────────────

function WinnersPanel({ round }: { round: ChatRaffleRoundView }) {
  return (
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
                <span className="text-sm text-muted-foreground">
                  Not drawn — no eligible entrant left
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {prize.label ? `${prize.label} · ` : ""}
                {prize.winnerTickets !== null
                  ? `${formatNumber(prize.winnerTickets)} tickets`
                  : "—"}
              </span>
            </div>

            {/* House POV: a prize is money leaving the house to a player. */}
            <span className="shrink-0 tabular-nums text-sm font-semibold text-rose-600 dark:text-rose-400">
              {formatCurrency(prize.amountUsd)}
            </span>

            {prize.winnerUserId &&
              (prize.paidAt ? (
                // Neutral, NOT emerald: house-POV colour means emerald = the
                // house gained. A prize leaving for a player is a cost, and
                // the amount beside this badge is already rose. A green
                // "Paid" chip would contradict it.
                <Badge
                  variant="outline"
                  className="h-5 shrink-0 px-1.5 text-[10px] text-muted-foreground uppercase"
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
      {round.drawSeed && (
        <p className="px-1 text-[11px] text-muted-foreground">
          Drawn {round.drawnAt ? formatDateTime(new Date(round.drawnAt)) : "—"}{" "}
          from {formatNumber(round.ticketsAtDraw ?? 0)} tickets across{" "}
          {formatNumber(round.entrantsAtDraw ?? 0)} entrants. Seed{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
            {round.drawSeed.slice(0, 16)}…
          </code>{" "}
          — the frozen snapshot and this seed reproduce the same winners.
        </p>
      )}
    </div>
  );
}

// ─── History ────────────────────────────────────────────────────────

async function RoundHistorySection() {
  const result = await safeQuery(
    () => getChatRaffleRounds(),
    [] as ChatRaffleRoundView[],
    "chat-raffle.rounds",
    ROUNDS_TIMEOUT_MS,
  );

  // Everything except the round the section above is already showing — so a
  // second scheduled or running round still appears somewhere.
  const featured = pickActiveRound(result.data);
  const past = result.data.filter((r) => r.id !== featured?.id);
  if (past.length === 0) return null;

  return (
    <FadeIn className="space-y-3">
      <SectionHeading icon={History} title="Other rounds" />
      <div className="overflow-hidden rounded-2xl border bg-card">
        {past.map((round) => (
          <div
            key={round.id}
            className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-semibold">{round.name}</span>
                <Badge
                  variant="outline"
                  className={cn(
                    "h-4 shrink-0 px-1 text-[9px] uppercase",
                    CHAT_RAFFLE_PHASE_COLOR[round.phase],
                  )}
                >
                  {CHAT_RAFFLE_PHASE_LABEL[round.phase]}
                </Badge>
              </div>
              <span className="text-xs text-muted-foreground">
                {formatDateTime(new Date(round.startsAt))} →{" "}
                {formatDateTime(new Date(round.endsAt))}
                {round.entrantsAtDraw !== null
                  ? ` · ${formatNumber(round.entrantsAtDraw)} entrants`
                  : ""}
              </span>
            </div>

            <div className="flex min-w-0 flex-col text-right">
              <span className="truncate text-xs text-muted-foreground">
                {round.prizes.filter((p) => p.winnerUserId).length > 0
                  ? round.prizes
                      .filter((p) => p.winnerUserId)
                      .map((p) => p.winnerUsername ?? "—")
                      .join(", ")
                  : "No winners"}
              </span>
              {round.unpaidPrizes > 0 && (
                <span className="text-[11px] text-amber-600 dark:text-amber-400">
                  {round.unpaidPrizes} unpaid
                </span>
              )}
            </div>

            <span className="shrink-0 tabular-nums text-sm font-semibold text-rose-600 dark:text-rose-400">
              {formatCurrency(round.prizePoolUsd)}
            </span>

            <Link
              href={`/chat-raffle/${round.id}`}
              className="shrink-0 text-xs font-medium text-primary hover:underline"
            >
              Details
            </Link>
          </div>
        ))}
      </div>
    </FadeIn>
  );
}

// ─── Notices + skeletons ────────────────────────────────────────────

function QueryFailedNotice() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <p className="text-xs text-amber-700 dark:text-amber-300">
        Couldn&apos;t score the chat window — the query timed out or failed.
        Refresh to retry.
      </p>
    </div>
  );
}

function TruncatedNotice() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <p className="text-xs text-amber-700 dark:text-amber-300">
        More than {formatNumber(CHAT_RAFFLE_MAX_ENTRIES)} users qualified, so
        the list below is clipped and the draw is blocked — drawing from a
        clipped pool would silently give the users past the cut zero chance.
        Raise the minimum points to enter (or shorten the window), then
        reload.
      </p>
    </div>
  );
}

function ActiveRoundSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-6 w-56 rounded" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
      <div className="rounded-2xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-32 rounded" />
          <Skeleton className="h-3 w-48 rounded" />
        </div>
        <div className="mt-4 space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}

function RoundHistorySkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-6 w-40 rounded" />
      <Skeleton className="h-32 w-full rounded-2xl" />
    </div>
  );
}
