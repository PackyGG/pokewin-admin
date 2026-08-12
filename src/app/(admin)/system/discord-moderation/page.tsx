import { Suspense } from "react";

import { FadeIn } from "@/components/fade-in";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requirePageAccess } from "@/lib/dal";
import { safeQueryOrNull, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { getDiscordModerationSettings } from "@/lib/discord-moderation-settings";
import { COMMUNITY_XP_GUILD_ID } from "@/lib/discord-community-ranks";
import {
  getCommunityXpDashboard,
  listCommunityLevelRoles,
} from "@/lib/discord-community-xp";

import { DiscordWorkspace } from "./discord-workspace";
import { DiscordWorkspaceSkeleton } from "./discord-workspace-skeleton";

export const metadata = { title: "Discord" };

/**
 * /system/discord-moderation — Discord XP & ranks, moderation and commands.
 *
 * Shell-first: the page body awaits nothing but the access gate, so the
 * PageHero paints immediately and the workspace streams in behind
 * <Suspense> (fallback mirrors this route's loading.tsx). Previously the
 * whole fan-out was awaited inline, holding First Paint on ~9 Admin-DB
 * round trips against a `max: 4` pool.
 */
export default async function DiscordModerationPage() {
  await requirePageAccess("/system/discord-moderation");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <Suspense fallback={<DiscordWorkspaceSkeleton />}>
        <DiscordWorkspaceBody />
      </Suspense>
    </div>
  );
}

async function DiscordWorkspaceBody() {
  const [settings, roles, xpDashboardResult] = await Promise.all([
    // Moderation settings and the rank-role map are EDIT SOURCES — their card
    // saves back exactly what it was handed. A silent fallback would let an
    // admin overwrite the live config with a placeholder, so these two keep
    // their throwing behaviour and a failure surfaces on the error boundary.
    getDiscordModerationSettings(),
    listCommunityLevelRoles(COMMUNITY_XP_GUILD_ID),
    // The XP dashboard is read-only display and by far the heaviest leg (six
    // aggregate reads plus the leaderboard). Isolated so a slow or failing
    // stats query degrades that one panel instead of taking the whole Discord
    // workspace — including the moderation and commands tabs — down with it.
    safeQueryOrNull(
      () => getCommunityXpDashboard(),
      "system.discord-community-xp-dashboard",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  return (
    <FadeIn>
      <DiscordWorkspace
        initialModeration={settings}
        initialRoles={roles}
        initialXpDashboard={xpDashboardResult.data}
        xpDashboardFailureKind={
          xpDashboardResult.error ? (xpDashboardResult.kind ?? "error") : null
        }
      />
    </FadeIn>
  );
}
