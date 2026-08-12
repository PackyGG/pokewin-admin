import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import {
  communityXpForLevel,
  getCommunityXpLeaderboard,
} from "@/lib/discord-community-xp";
import {
  getActiveChatRaffleRound,
  getChatRaffleRounds,
  getRoundAdjustmentTotals,
  getRoundEntries,
} from "@/lib/chat-raffle/rounds";
import { getChatRaffleStandings } from "@/lib/chat-raffle/standings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Body = z.object({ limit: z.number().int().min(1).max(30).default(10) }).strict();
export const POST = withApiKey({ scopes: ["discord:community-xp"] }, async (request) => {
  const body = Body.safeParse(await request.json().catch(() => ({})));
  if (!body.success) return apiError(400, "invalid_request", "Invalid community XP leaderboard request.");

  let competition = await getActiveChatRaffleRound("leaderboard");
  if (!competition) {
    const latestFinalized = (await getChatRaffleRounds(50, "leaderboard"))
      .find((round) => round.status === "drawn");
    if (latestFinalized) {
      competition = latestFinalized;
      const entries = await getRoundEntries(competition.id, body.data.limit);
      return {
        competition: competitionPayload(competition),
        profiles: entries.flatMap((entry) => {
          if (
            !entry.discordUserId
            || entry.communityTotalXp === null
            || entry.communityLevel === null
            || entry.discordXp === null
            || entry.siteChatXp === null
            || entry.discordMessageCount === null
            || entry.siteChatMessageCount === null
          ) return [];
          return [{
            discordUserId: entry.discordUserId,
            totalXp: entry.communityTotalXp,
            discordXp: entry.discordXp,
            siteChatXp: entry.siteChatXp,
            countedMessages: entry.messageCount,
            level: entry.communityLevel,
            currentLevelXp: communityXpForLevel(entry.communityLevel),
            nextLevelXp: communityXpForLevel(entry.communityLevel + 1),
            rank: entry.position,
            competitionXp: entry.tickets,
            discordMessageCount: entry.discordMessageCount,
            siteChatMessageCount: entry.siteChatMessageCount,
          }];
        }),
      };
    }
    return {
      competition: null,
      profiles: await getCommunityXpLeaderboard(body.data.limit),
    };
  }

  const adjustments = await getRoundAdjustmentTotals(competition.id);
  const result = await getChatRaffleStandings({
    startsAt: new Date(competition.startsAt),
    endsAt: new Date(competition.endsAt),
    adjustments,
    limit: body.data.limit,
  });

  return {
    competition: competitionPayload(competition),
    profiles: result.standings.map((standing) => ({
      discordUserId: standing.discordUserId,
      totalXp: standing.communityTotalXp,
      discordXp: standing.discordXp,
      siteChatXp: standing.siteChatXp,
      countedMessages: standing.messageCount,
      level: standing.communityLevel,
      currentLevelXp: communityXpForLevel(standing.communityLevel),
      nextLevelXp: communityXpForLevel(standing.communityLevel + 1),
      rank: standing.position,
      competitionXp: standing.points,
      discordMessageCount: standing.discordMessageCount,
      siteChatMessageCount: standing.siteChatMessageCount,
    })),
  };
});

function competitionPayload(competition: Awaited<ReturnType<typeof getActiveChatRaffleRound>>) {
  if (!competition) return null;
  return {
    id: competition.id,
    name: competition.name,
    phase: competition.phase,
    startsAt: competition.startsAt,
    endsAt: competition.endsAt,
    prizes: competition.prizes.map((prize) => ({
      position: prize.position,
      amountUsd: prize.amountUsd,
      label: prize.label,
    })),
  };
}
