import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  compareLeaderboardCandidates,
  selectLeaderboardWinners,
} from "../../src/lib/chat-raffle/leaderboard";

test("XP leaderboard ranks by XP, then earliest score, with distinct winners", () => {
  const candidates = [
    {
      userId: "later",
      points: 300,
      scoreReachedAt: "2026-08-12T12:00:00.000Z",
    },
    {
      userId: "lower",
      points: 150,
      scoreReachedAt: "2026-08-12T08:00:00.000Z",
    },
    {
      userId: "earlier",
      points: 300,
      scoreReachedAt: "2026-08-12T10:00:00.000Z",
    },
  ];

  assert.deepEqual(
    candidates
      .slice()
      .sort(compareLeaderboardCandidates)
      .map((entry) => entry.userId),
    ["earlier", "later", "lower"],
  );
  assert.deepEqual(
    selectLeaderboardWinners(candidates, 2).map((entry) => entry.userId),
    ["earlier", "later"],
  );
});

test("chat leaderboard is persisted, finalized by rank, and exposed on the page", async () => {
  const [migration, actions, page, dialogs, apiRoute, standings] =
    await Promise.all([
      readFile(
        "drizzle/admin/migrations/20260812_chat_competition_leaderboards.sql",
        "utf8",
      ),
      readFile("src/app/(admin)/chat-raffle/actions.ts", "utf8"),
      readFile("src/app/(admin)/chat-raffle/page.tsx", "utf8"),
      readFile("src/app/(admin)/chat-raffle/chat-raffle-dialogs.tsx", "utf8"),
      readFile(
        "src/app/api/v1/discord/community-xp/leaderboard/route.ts",
        "utf8",
      ),
      readFile("src/lib/chat-raffle/standings.ts", "utf8"),
    ]);

  assert.match(migration, /competition_type/);
  assert.match(migration, /score_reached_at/);
  assert.match(actions, /finalizeChatLeaderboard/);
  assert.match(actions, /selectLeaderboardWinners/);
  assert.match(page, /competitionType="raffle"/);
  assert.match(page, /competitionType="leaderboard"/);
  assert.doesNotMatch(page, /CompetitionNavigation/);
  assert.doesNotMatch(page, /No round running/);
  assert.doesNotMatch(page, /No XP leaderboard running/);
  assert.doesNotMatch(page, /title="Chat Raffle"/);
  assert.match(page, /<PageHeroIdentity/);
  assert.match(page, /<LifetimeCommunityXpSection \/>/);
  assert.match(page, /Active XP leaderboard/);
  assert.match(page, /formatNumber\(entry\.tickets\)/);
  assert.match(page, /className="flex flex-wrap items-center gap-3 border-b/);
  assert.match(page, /grid-cols-3/);
  assert.match(page, /<div className="space-y-4">/);
  assert.match(page, /<FadeIn className="space-y-4">/);
  assert.equal(
    page.match(/mode="create" competitionType="leaderboard"/g)?.length,
    1,
  );
  assert.match(page, /FinalizeLeaderboardButton/);
  assert.match(dialogs, /\(\[7, 14\] as const\)/);
  assert.match(dialogs, /Starts immediately when created/);
  assert.match(actions, /data\.durationDays! \* MS_PER_DAY/);
  assert.match(apiRoute, /competition\.phase !== "running"/);
  assert.match(apiRoute, /competition: null,[\s\S]*profiles: \[\]/);
  assert.doesNotMatch(apiRoute, /latestFinalized|getCommunityXpLeaderboard/);
  assert.match(standings, /max\(event\.occurred_at\) AS score_reached_at/);
  assert.match(standings, /withTransientPostgresReadRetry/);
  assert.match(standings, /chat-raffle-lifetime-standings-v1/);
});
