import { Suspense } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Clock,
  Dices,
  History,
  ListOrdered,
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
  canDrawRound,
  canEditRound,
  competitionPhaseLabel,
  positionColor,
  type ChatCompetitionType,
} from "@/lib/chat-raffle/config";
import {
  getActiveChatRaffleRound,
  getChatRaffleRounds,
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
  FinalizeLeaderboardButton,
  PayPrizeDialog,
  RoundFormDialog,
} from "./chat-raffle-dialogs";

export const metadata = { title: "Chat Raffle" };

/**
 * Players → Chat Raffle.
 *
 * Qualifying Discord and linked on-site messages become Community XP. Raffles
 * turn XP into weighted tickets; XP leaderboards award prizes by final rank.
 * XP decisions, competitions, manual corrections and frozen result snapshots
 * live in the ADMIN DB. MAIN is read only to resolve Discord ids to eligible
 * Packy users; its single write is the existing winner payout path.
 *
 * Shell-first: the page paints immediately and both data legs stream in
 * behind their own Suspense boundaries (see loading.tsx for the matching
 * skeletons).
 */

/** Bounded indexed XP-event aggregate plus a linked-user MAIN lookup. */
const STANDINGS_TIMEOUT_MS = 20_000;
const ROUNDS_TIMEOUT_MS = 10_000;

export default async function ChatRafflePage() {
  await requirePageAccess("/chat-raffle");

  return (
    <div className="space-y-4">
      <PageHero>
        <SectionHeading
          icon={Trophy}
          title="Chat Raffle & XP Leaderboard"
          action={
            <>
              <RoundFormDialog
                mode="create"
                competitionType="raffle"
                triggerVariant="outline"
              />
              <RoundFormDialog mode="create" competitionType="leaderboard" />
            </>
          }
        />
      </PageHero>

      <Suspense fallback={<ActiveRoundSkeleton />}>
        <ActiveRoundSection competitionType="raffle" />
      </Suspense>

      <Suspense fallback={<ActiveRoundSkeleton />}>
        <ActiveRoundSection competitionType="leaderboard" />
      </Suspense>

      <Suspense fallback={<RoundHistorySkeleton />}>
        <RoundHistorySection competitionType="raffle" />
      </Suspense>

      <Suspense fallback={<RoundHistorySkeleton />}>
        <RoundHistorySection competitionType="leaderboard" />
      </Suspense>
    </div>
  );
}

// ─── Active round ───────────────────────────────────────────────────

async function ActiveRoundSection({
  competitionType,
}: {
  competitionType: ChatCompetitionType;
}) {
  const roundResult = await safeQuery(
    () => getActiveChatRaffleRound(competitionType),
    null,
    "chat-raffle.active-round",
    ROUNDS_TIMEOUT_MS,
  );
  const round = roundResult.data;

  if (!round) {
    if (competitionType === "raffle") return null;
    return <NoActiveRound competitionType={competitionType} />;
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
        adjustments: adjustments.data,
      }),
    { standings: [], totalTickets: 0, entrants: 0, truncated: false },
    "chat-raffle.standings",
    STANDINGS_TIMEOUT_MS,
  );

  const { standings, totalTickets, entrants, truncated } = standingsResult.data;
  const discordXp = standings.reduce((sum, entry) => sum + entry.discordXp, 0);
  const siteChatXp = standings.reduce((sum, entry) => sum + entry.siteChatXp, 0);
  const editable = canEditRound(round.phase);

  return (
    <FadeIn className="space-y-6">
      <SectionHeading
        icon={competitionType === "leaderboard" ? ListOrdered : Dices}
        title={
          <>
            {round.name}
            <Badge
              variant="outline"
              className={cn("h-5 px-1.5 text-[10px] uppercase", CHAT_RAFFLE_PHASE_COLOR[round.phase])}
            >
              {competitionPhaseLabel(round.phase, competitionType)}
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
                  competitionType: round.competitionType,
                  name: round.name,
                  startsAt: round.startsAt,
                  endsAt: round.endsAt,
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
              competitionType === "leaderboard" ? (
                <FinalizeLeaderboardButton
                  roundId={round.id}
                  leaderboardName={round.name}
                  entrants={entrants}
                  totalXp={totalTickets}
                  prizeCount={round.prizes.length}
                  disabled={entrants === 0 || truncated}
                />
              ) : (
                <DrawRoundButton
                  roundId={round.id}
                  roundName={round.name}
                  entrants={entrants}
                  totalTickets={totalTickets}
                  prizeCount={round.prizes.length}
                  disabled={entrants === 0 || truncated}
                />
              )
            )}
            <RoundFormDialog
              mode="create"
              competitionType={competitionType}
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
          label={competitionType === "leaderboard" ? "XP earned" : "Tickets"}
          value={formatNumber(totalTickets)}
          sub={competitionType === "leaderboard" ? "determines rank" : "1 XP = 1 ticket"}
          icon={competitionType === "leaderboard" ? ListOrdered : Ticket}
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="text-sm font-semibold">Combined Community XP</span>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {competitionType === "leaderboard"
                ? "Qualifying XP earned inside this window determines the live rank."
                : "Qualifying XP earned inside this round becomes tickets."}
            </p>
          </div>
          <div className="flex gap-2 text-xs tabular-nums">
            <Badge variant="outline">Discord {formatNumber(discordXp)} XP</Badge>
            <Badge variant="outline">Site {formatNumber(siteChatXp)} XP</Badge>
          </div>
        </div>
      </div>

      {standingsResult.error !== null && <QueryFailedNotice />}
      {truncated && <TruncatedNotice />}

      <StandingsTable
        standings={standings}
        totalTickets={totalTickets}
        roundId={round.id}
        adjustable={editable}
        competitionType={competitionType}
        prizes={round.prizes}
        emptyMessage={competitionType === "leaderboard"
          ? "Nobody has qualified for this leaderboard yet."
          : "Nobody has qualified for this round yet."}
      />

      {round.prizes.some((p) => p.winnerUserId) && (
        <WinnersPanel round={round} />
      )}
    </FadeIn>
  );
}

/**
 * No open round: show the lifetime combined Community XP leaderboard so an
 * operator can inspect established community standing before opening a round.
 */
async function NoActiveRound({
  competitionType,
}: {
  competitionType: ChatCompetitionType;
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
        timeframe: "lifetime",
      }),
    { standings: [], totalTickets: 0, entrants: 0, truncated: false },
    "chat-raffle.preview",
    STANDINGS_TIMEOUT_MS,
  );

  return (
    <FadeIn className="space-y-4">
      <div className="rounded-2xl border border-dashed p-4 text-center sm:p-5">
        <ListOrdered className="mx-auto size-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">
          Create a leaderboard to reward the top XP earners
        </p>
        <p className="mx-auto mt-1 max-w-lg text-xs text-muted-foreground">
          Below is the lifetime Community XP leaderboard across Discord and
          linked on-site chat. Nothing is being counted toward a prize.
        </p>
      </div>

      {preview.error !== null && <QueryFailedNotice />}

      <SectionHeading icon={MessageSquare} title="Lifetime Community XP leaderboard" />
      <StandingsTable
        standings={preview.data.standings}
        totalTickets={preview.data.totalTickets}
        roundId={null}
        adjustable={false}
        lifetime
        competitionType={competitionType}
        emptyMessage="No qualifying Community XP has been recorded yet."
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
  competitionType = "raffle",
  prizes = [],
  lifetime = false,
  emptyMessage,
}: {
  standings: ChatRaffleStanding[];
  totalTickets: number;
  roundId: string | null;
  adjustable: boolean;
  competitionType?: ChatCompetitionType;
  prizes?: ChatRaffleRoundView["prizes"];
  lifetime?: boolean;
  emptyMessage: string;
}) {
  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Standings</span>
        <span className="text-xs text-muted-foreground">
          {formatNumber(standings.length)}{" "}
          {standings.length === 1 ? "entrant" : "entrants"} ·{" "}
          {formatNumber(totalTickets)} {lifetime || competitionType === "leaderboard" ? "XP" : "tickets"}
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
            return (
              <div
                key={entry.userId}
                className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
              >
                <div
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-bold",
                    positionColor(entry.position),
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

                <div className="min-w-40 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
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
                    <Badge
                      variant="outline"
                      className="h-4 shrink-0 px-1 text-[9px]"
                      title={`${formatNumber(entry.communityTotalXp)} lifetime XP`}
                    >
                      Lv {entry.communityLevel} · {entry.communityRankName}
                    </Badge>
                    {competitionType === "leaderboard" && prizes[entry.position - 1] && (
                      <Badge
                        variant="outline"
                        className="h-4 shrink-0 px-1 text-[9px] text-rose-600 dark:text-rose-400"
                      >
                        {formatCurrency(prizes[entry.position - 1].amountUsd)} prize
                      </Badge>
                    )}
                  </div>
                </div>

                <div
                  className="order-last ml-11 grid w-[calc(100%-2.75rem)] shrink-0 grid-cols-2 overflow-hidden rounded-lg border bg-muted/30 sm:order-none sm:ml-0 sm:w-auto"
                  title={`${formatNumber(entry.messageCount)} qualifying messages total`}
                >
                  <div className="min-w-24 px-3 py-1.5">
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Discord
                    </div>
                    <div className="mt-0.5 tabular-nums text-sm font-semibold leading-none">
                      {formatNumber(entry.discordMessageCount)}
                      <span className="ml-1 text-[10px] font-normal text-muted-foreground">msgs</span>
                    </div>
                  </div>
                  <div className="min-w-24 border-l px-3 py-1.5">
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                      On-site
                    </div>
                    <div className="mt-0.5 tabular-nums text-sm font-semibold leading-none">
                      {formatNumber(entry.siteChatMessageCount)}
                      <span className="ml-1 text-[10px] font-normal text-muted-foreground">msgs</span>
                    </div>
                  </div>
                </div>

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
                positionColor(prize.position),
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
                  {round.competitionType === "leaderboard"
                    ? "No ranked player for this place"
                    : "Not drawn — no eligible entrant left"}
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {prize.label ? `${prize.label} · ` : ""}
                {prize.winnerTickets !== null
                  ? `${formatNumber(prize.winnerTickets)} ${round.competitionType === "leaderboard" ? "XP" : "tickets"}`
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
      {round.competitionType === "leaderboard" && round.drawnAt && (
        <p className="px-1 text-[11px] text-muted-foreground">
          Finalized {formatDateTime(new Date(round.drawnAt))} from a frozen
          ranking of {formatNumber(round.entrantsAtDraw ?? 0)} entrants.
        </p>
      )}
    </div>
  );
}

// ─── History ────────────────────────────────────────────────────────

async function RoundHistorySection({
  competitionType,
}: {
  competitionType: ChatCompetitionType;
}) {
  const result = await safeQuery(
    () => getChatRaffleRounds(50, competitionType),
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
      <SectionHeading
        icon={History}
        title={competitionType === "leaderboard" ? "Other XP leaderboards" : "Other rounds"}
      />
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
                  {competitionPhaseLabel(round.phase, competitionType)}
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
        the list below is clipped and finalizing winners is blocked — using a
        clipped result would silently exclude the users past the cut.
        Shorten the round window, then reload.
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
