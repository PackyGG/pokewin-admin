import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Trophy } from "lucide-react";
import { getBattleDetail } from "@/lib/queries/battles";
import { requirePageAccess } from "@/lib/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { CardImage } from "@/components/card-image";
import { CancelBattleButton } from "./cancel-button";

const BATTLE_STATUS_COLORS: Record<string, string> = {
  waiting: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  in_progress: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  animating: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  completed: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-700/90 text-zinc-100",
  uncommon: "bg-green-700/90 text-green-100",
  rare: "bg-blue-700/90 text-blue-100",
  "ultra rare": "bg-purple-700/90 text-purple-100",
  "secret rare": "bg-yellow-600/90 text-yellow-100",
  legendary: "bg-orange-600/90 text-orange-100",
  holo: "bg-cyan-700/90 text-cyan-100",
  secret: "bg-pink-700/90 text-pink-100",
};

const RESULT_COLORS: Record<string, string> = {
  win: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  lose: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  draw: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
};

export default async function BattleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("/battles");
  const { id } = await params;
  const data = await getBattleDetail(id);

  if (!data) notFound();

  const totalParticipants = data.teamsData.reduce((s, t) => s + t.players.length, 0);
  const cardsPerPlayer = data.teamsData[0]?.players[0]?.cards.length ?? 0;
  const totalPacksOpened = totalParticipants * cardsPerPlayer;
  const totalWagered = data.betAmount * totalParticipants;
  const totalCardValue = data.teamsData.reduce((s, t) => s + t.teamTotalValue, 0);
  const houseProfit = totalWagered - totalCardValue;
  const houseEdgePct = totalWagered > 0 ? (houseProfit / totalWagered) * 100 : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/battles" className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Battle</h1>
            <Badge variant="outline" className={BATTLE_STATUS_COLORS[data.status] ?? ""}>
              {data.status.replace(/_/g, " ")}
            </Badge>
            <Badge variant="outline">{data.mode}</Badge>
          </div>
          <p className="font-mono text-xs text-muted-foreground">{data.id}</p>
        </div>
        {data.status === "waiting" && <CancelBattleButton battleId={data.id} />}
      </div>

      {/* Details */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-6">
            {data.packs.length > 0 && (
              <div className="flex gap-4 shrink-0">
                {data.packs.map((pack) => (
                  <Link
                    key={pack.id}
                    href={`/packs/${pack.id}`}
                    className="hover:opacity-80 transition-opacity text-center"
                  >
                    <CardImage
                      src={pack.imageUrl}
                      alt={pack.name}
                      className="h-48 w-auto rounded"
                    />
                    <p className="text-sm font-medium mt-1.5">{pack.name}</p>
                    <p className="text-xs text-muted-foreground">{formatCurrency(pack.priceUsd)}</p>
                  </Link>
                ))}
              </div>
            )}
            <div className="space-y-3">
              <InfoRow label="Creator">
                <Link href={`/users/${data.userId}`} className="hover:underline">
                  {data.username ?? data.userId}
                </Link>
              </InfoRow>
              <InfoRow label="Mode"><Badge variant="outline">{data.mode}</Badge></InfoRow>
              <InfoRow label="Teams">{data.teams} x {data.playersPerTeam}</InfoRow>
              <InfoRow label="Bet">{formatCurrency(data.betAmount)}</InfoRow>
              <InfoRow label="Region"><Badge variant="outline">{data.regionCode}</Badge></InfoRow>
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
          {data.status === "completed" && (
            <div className="border-t mt-4 pt-4 grid grid-cols-2 sm:grid-cols-5 gap-4">
              {[
                { label: "Packs Opened", value: String(totalPacksOpened) },
                { label: "Total Wagered", value: formatCurrency(totalWagered) },
                { label: "Total Card Value", value: formatCurrency(totalCardValue) },
                { label: "House Profit", value: formatCurrency(houseProfit), color: houseProfit >= 0 ? "text-green-400" : "text-red-400" },
                { label: "House Edge", value: `${houseEdgePct.toFixed(2)}%`, color: houseEdgePct >= 0 ? "text-green-400" : "text-red-400" },
              ].map((stat) => (
                <div key={stat.label}>
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                  <p className={`text-sm font-semibold ${stat.color ?? ""}`}>{stat.value}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Teams */}
      {data.teamsData.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.teamsData.map((team) => (
            <Card key={team.teamNumber} className={team.isWinner ? "border-green-500/30" : ""}>
              <CardHeader>
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  Team {team.teamNumber}
                  {team.isWinner && (
                    <Badge variant="outline" className="bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30">
                      <Trophy className="size-3 mr-1" />
                      Winner
                    </Badge>
                  )}
                  <span className="ml-auto text-muted-foreground font-normal">
                    {formatCurrency(team.teamTotalValue)}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
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
                      <span className="text-sm font-medium">
                        {formatCurrency(player.totalValue)}
                      </span>
                    </div>
                    {player.cards.length > 0 && (
                      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
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
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Provably Fair */}
      {data.provablyFairResults.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Provably Fair</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
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
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}
