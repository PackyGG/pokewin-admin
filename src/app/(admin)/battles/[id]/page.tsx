import { notFound } from "next/navigation";
import Link from "next/link";
import {
  Trophy,
  Swords,
  Package,
  DollarSign,
  Coins,
  TrendingUp,
  Percent,
  ShieldCheck,
  Users as UsersIcon,
} from "lucide-react";
import { getBattleDetailCached } from "@/lib/queries/battles-cache";
import { requirePageAccess } from "@/lib/dal";
import { isUuid } from "@/lib/utils/ids";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { PRIMARY_QUERY_TIMEOUT_MS } from "@/lib/entity-surface/loader";
import { InlineError } from "@/components/entity-surface";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { CardImage } from "@/components/card-image";
import { CancelBattleButton } from "./cancel-button";
import { BattlePasswordReveal } from "./password-reveal";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Battle Detail" };

const BATTLE_STATUS_COLORS: Record<string, string> = {
  waiting: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  in_progress: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  animating: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-700/90 text-zinc-100",
  uncommon: "bg-emerald-700/90 text-emerald-100",
  rare: "bg-blue-700/90 text-blue-100",
  "ultra rare": "bg-purple-700/90 text-purple-100",
  "secret rare": "bg-yellow-600/90 text-yellow-100",
  legendary: "bg-orange-600/90 text-orange-100",
  holo: "bg-cyan-700/90 text-cyan-100",
  secret: "bg-pink-700/90 text-pink-100",
};

// House-POV per CLAUDE.md: user-win → rose (house pays out),
// user-lose → emerald (house keeps the wager).
const RESULT_COLORS: Record<string, string> = {
  win: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  lose: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  draw: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
};

export default async function BattleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePageAccess("/battles");
  const { id } = await params;
  // Shape-check UUID before any DB call — see src/lib/utils/ids.ts.
  if (!isUuid(id)) notFound();
  // Wrapped in safeQueryOrNull + timeout so a slow or failed detail read
  // degrades to an inline error in place instead of white-screening the
  // whole route via the error boundary. A genuine "not found" is a `null`
  // data WITHOUT an error → notFound(); a thrown/timed-out query carries an
  // `error` → InlineError.
  const { data, error } = await safeQueryOrNull(
    () => getBattleDetailCached(id),
    "battles.detail",
    PRIMARY_QUERY_TIMEOUT_MS,
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHero>
          <PageHeroIdentity
            icon={Swords}
            backHref="/battles"
            title="Battle"
            subtitle={id}
            subtitleClassName="font-mono truncate"
          />
        </PageHero>
        <InlineError
          title="Couldn't load this battle"
          hint="The battle query timed out or failed. Retry in a moment, or go back to the list."
        />
      </div>
    );
  }

  if (!data) notFound();

  const totalParticipants = data.teamsData.reduce((s, t) => s + t.players.length, 0);
  const cardsPerPlayer = data.teamsData[0]?.players[0]?.cards.length ?? 0;
  const totalPacksOpened = totalParticipants * cardsPerPlayer;
  const totalWagered = data.betAmount * totalParticipants;

  // Pre-resolved (pending) battle: outcome is materialized in the DB
  // (`winner_team` + `total_unpacked`) before the on-site animation
  // settles, but the provably_fair_results rows that `teamsData` derives
  // from aren't written yet — so the teamsData total card value is 0
  // while pending. Source the Hit from `total_unpacked` for these rows.
  const isPending = data.status === "in_progress" || data.status === "animating";
  const pendingHit = data.totalUnpacked;
  // Show the House P&L strip for completed battles (as before) AND for
  // pending battles whose outcome is already locked in.
  const showKpiStrip = data.status === "completed" || (isPending && pendingHit != null);
  const totalCardValue =
    isPending && pendingHit != null
      ? pendingHit
      : data.teamsData.reduce((s, t) => s + t.teamTotalValue, 0);
  const houseProfit = totalWagered - totalCardValue;
  const houseEdgePct = totalWagered > 0 ? (houseProfit / totalWagered) * 100 : 0;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Swords}
          backHref="/battles"
          title="Battle"
          badges={
            <>
              <Badge variant="outline" className={BATTLE_STATUS_COLORS[data.status] ?? ""}>
                {data.status.replace(/_/g, " ")}
              </Badge>
              <Badge variant="outline">{data.mode}</Badge>
            </>
          }
          subtitle={data.id}
          subtitleClassName="font-mono truncate"
          action={data.status === "waiting" ? <CancelBattleButton battleId={data.id} /> : undefined}
        />
      </PageHero>

      {/* Pre-resolved pending battle: outcome is locked in the DB but the
          on-site animation hasn't settled yet. Make that explicit so the
          admin reads the KPI strip below as a determined-but-settling
          result, not a finalized one. */}
      {showKpiStrip && isPending && (
        <Badge
          variant="outline"
          className="bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30"
        >
          Outcome locked — settling
        </Badge>
      )}

      {/* KPI strip - completed battles + pre-resolved pending battles */}
      {showKpiStrip && (
        <div className="grid gap-2.5 sm:gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          <KpiTile
            label="Packs Opened"
            // PF result rows aren't written while a battle is animating,
            // so the per-player card counts aren't known yet — show "—"
            // rather than a fabricated 0. Resolves once the battle settles.
            value={isPending ? "—" : String(totalPacksOpened)}
            icon={Package}
            accent="cyan"
          />
          {/* House-POV per CLAUDE.md: a wager = users risking money the
              house takes in → emerald (house gain), never neutral blue. */}
          <KpiTile
            label="Total Wagered"
            value={formatCurrency(totalWagered)}
            icon={DollarSign}
            accent="emerald"
          />
          <KpiTile
            label="Total Card Value"
            value={formatCurrency(totalCardValue)}
            icon={Coins}
            accent="amber"
          />
          <KpiTile
            label="House Profit"
            value={formatCurrency(houseProfit)}
            icon={TrendingUp}
            accent={houseProfit >= 0 ? "emerald" : "rose"}
          />
          <KpiTile
            label="House Edge"
            value={`${houseEdgePct.toFixed(2)}%`}
            icon={Percent}
            accent={houseEdgePct >= 0 ? "emerald" : "rose"}
          />
        </div>
      )}

      {/* Details */}
      <div className="space-y-3">
        <SectionHeading icon={Swords} title="Details" />
        <FadeIn>
          <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
            <div className="relative p-4 sm:p-5 md:p-6 flex gap-4 sm:gap-6 flex-wrap">
              {data.packs.length > 0 && (
                <div className="flex flex-wrap gap-3 sm:gap-4 shrink-0">
                  {data.packs.map((pack) => (
                    <Link
                      key={pack.id}
                      href={`/packs/${pack.id}`}
                      className="hover:opacity-80 transition-opacity text-center"
                    >
                      <CardImage
                        src={pack.imageUrl}
                        alt={pack.name}
                        className="h-36 sm:h-48 w-auto rounded"
                      />
                      <p className="text-sm font-medium mt-1.5 truncate max-w-[120px] sm:max-w-none">{pack.name}</p>
                      <p className="text-xs text-muted-foreground">{formatCurrency(pack.priceUsd)}</p>
                    </Link>
                  ))}
                </div>
              )}
              <div className="space-y-3 flex-1 min-w-0 sm:min-w-[240px]">
                <InfoRow label="Creator">
                  <Link href={`/users/${data.userId}`} className="hover:underline">
                    {data.username ?? data.userId}
                  </Link>
                </InfoRow>
                <InfoRow label="Mode"><Badge variant="outline">{data.mode}</Badge></InfoRow>
                <InfoRow label="Teams">{data.teams} x {data.playersPerTeam}</InfoRow>
                <InfoRow label="Bet">{formatCurrency(data.betAmount)}</InfoRow>
                <InfoRow label="Region"><Badge variant="outline">{data.regionCode}</Badge></InfoRow>
                {data.hasPassword && session.role === "admin" && (
                  <InfoRow label="Password">
                    <BattlePasswordReveal battleId={data.id} />
                  </InfoRow>
                )}
                {data.winnerTeam && <InfoRow label="Winner Team">Team {data.winnerTeam}</InfoRow>}
                {data.sponsorshipPercentage > 0 && (
                  <InfoRow label="Sponsorship">{data.sponsorshipPercentage}%</InfoRow>
                )}
                {data.borrowPercentage > 0 && (
                  <InfoRow label="Borrow">{data.borrowPercentage}%</InfoRow>
                )}
                <InfoRow label="Created">{formatDateTime(data.createdAt)}</InfoRow>
              </div>
            </div>
          </div>
        </FadeIn>
      </div>

      {/* Teams */}
      {data.teamsData.length > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={UsersIcon} title="Teams" />
          <FadeIn>
            <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
              {data.teamsData.map((team) => (
                <div
                  key={team.teamNumber}
                  className={`relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 ${
                    team.isWinner ? "border-rose-500/30" : ""
                  }`}
                >
                  <div className="relative p-4 sm:p-5">
                    <div className="mb-4 flex items-center gap-2">
                      <h3 className="text-sm font-medium">Team {team.teamNumber}</h3>
                      {team.isWinner && (
                        // House-POV: user team winning = house paying out → rose.
                        <Badge variant="outline" className="bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30">
                          <Trophy className="size-3 mr-1" />
                          Winner
                        </Badge>
                      )}
                      <span className="ml-auto text-muted-foreground font-normal text-sm">
                        {formatCurrency(team.teamTotalValue)}
                      </span>
                    </div>
                    <div className="space-y-4">
                      {team.players.map((player) => (
                        <div key={player.id} className="space-y-2">
                          <div className="flex items-center gap-2">
                            {player.userId ? (
                              <Link href={`/users/${player.userId}`} className="text-sm font-medium hover:underline">
                                {player.username ?? player.userId.slice(0, 8)}
                              </Link>
                            ) : (
                              <span className="text-sm text-muted-foreground">
                                {player.botUsername ?? "Bot"}
                              </span>
                            )}
                            {player.result && (
                              <Badge variant="outline" className={RESULT_COLORS[player.result] ?? ""}>
                                {player.result}
                              </Badge>
                            )}
                            {player.borrowPercentage > 0 && (
                              <Badge
                                variant="outline"
                                className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
                              >
                                {player.borrowPercentage}% borrow
                              </Badge>
                            )}
                            <span className="text-sm font-medium">
                              {formatCurrency(player.totalValue)}
                            </span>
                          </div>
                          {player.cards.length > 0 && (
                            <FadeIn
                              speed="fast"
                              className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2"
                            >
                              {player.cards.map((card) => (
                                <div
                                  key={card.id}
                                  className="rounded-lg border bg-card overflow-hidden"
                                >
                                  <div className="aspect-[2/3] relative bg-muted">
                                    <CardImage
                                      src={card.imageUrl}
                                      alt={card.cardName}
                                      className="size-full rounded-t-lg"
                                    />
                                    {card.rarity && (
                                      <span
                                        className={`absolute bottom-1 left-1 rounded px-1 py-0.5 text-[10px] font-semibold leading-none shadow backdrop-blur-sm ${RARITY_COLORS[card.rarity.toLowerCase()] ?? "bg-black/80 text-white"}`}
                                      >
                                        {card.rarity}
                                      </span>
                                    )}
                                  </div>
                                  <div className="p-1.5 space-y-0.5">
                                    <p className="text-[11px] font-medium truncate" title={card.cardName}>
                                      {card.cardName}
                                    </p>
                                    <p className="text-[10px] text-muted-foreground">
                                      {formatCurrency(card.valueAtObtained)}
                                    </p>
                                  </div>
                                </div>
                              ))}
                            </FadeIn>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </FadeIn>
        </div>
      )}

      {/* Provably Fair */}
      {data.provablyFairResults.length > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={ShieldCheck} title="Provably Fair" />
          <FadeIn>
            <div className="rounded-2xl border bg-card/60 p-5 space-y-3">
              <InfoRow label="Server Seed Hash">
                <span className="font-mono text-xs break-all">{data.serverSeedHash}</span>
              </InfoRow>
              {data.eosBlockHash && (
                <InfoRow label="EOS Block Hash">
                  <span className="font-mono text-xs break-all">{data.eosBlockHash}</span>
                </InfoRow>
              )}
              <p className="text-xs text-muted-foreground pt-2">
                {data.provablyFairResults.length} result(s)
              </p>
            </div>
          </FadeIn>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm min-w-0 break-words">{children}</span>
    </div>
  );
}
