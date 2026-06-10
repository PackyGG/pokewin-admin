import { Lock, Banknote, Trophy, Percent, Coins, Gem } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getSiteConfig } from "@/lib/queries/security";
import { SecurityContent } from "./security-content";
import { PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { RAIN_CONFIG_SITE_CONFIG_KEYS } from "../rain/config-keys";
import { WAGER_REQUIREMENT_SITE_CONFIG_KEYS } from "./wager-requirement-keys";
import { WagerRequirementCard } from "./wager-requirement-card";
import { LEADERBOARD_WAGER_WEIGHT_SITE_CONFIG_KEYS } from "./leaderboard-wager-weights-keys";
import { LeaderboardWagerWeightsCard } from "./leaderboard-wager-weights-card";
import { RAKEBACK_WAGER_WEIGHT_SITE_CONFIG_KEYS } from "./rakeback-wager-weights-keys";
import { RakebackWagerWeightsCard } from "./rakeback-wager-weights-card";
import { SOURCE_WAGER_WEIGHT_SITE_CONFIG_KEYS } from "./source-wager-weights-keys";
import { SourceWagerWeightsCard } from "./source-wager-weights-card";
import { SHARD_WAGER_WEIGHT_SITE_CONFIG_KEYS } from "./shard-wager-weights-keys";
import { ShardWagerWeightsCard } from "./shard-wager-weights-card";
import {
  getWagerRequirementDefaults,
  type WagerRequirementDefaults,
} from "@/lib/backend-api/wager-requirements";
import {
  getLeaderboardWagerWeights,
  type LeaderboardWagerWeights,
} from "@/lib/backend-api/leaderboard-wager-weights";
import {
  getRakebackWagerWeights,
  type RakebackWagerWeights,
} from "@/lib/backend-api/rakeback-wager-weights";
import {
  getSourceWagerWeights,
  type SourceWagerWeights,
} from "@/lib/backend-api/source-wager-weights";
import {
  getShardWagerWeights,
  type ShardWagerWeights,
} from "@/lib/backend-api/shard-wager-weights";

export const metadata = { title: "Security" };

export default async function SecurityPage() {
  await requirePageAccess("/security");
  const allConfig = await getSiteConfig();

  // Rain-specific site_config keys are managed on /rain?tab=config; the
  // withdrawal wager-requirement and leaderboard wager-weight keys are
  // managed by the dedicated cards below (written through the backend
  // API). Hide all groups from the generic config table so the same row
  // isn't editable in two surfaces (would cause confusion + duplicate
  // audit events).
  const movedKeys = new Set<string>([
    ...RAIN_CONFIG_SITE_CONFIG_KEYS,
    ...WAGER_REQUIREMENT_SITE_CONFIG_KEYS,
    ...LEADERBOARD_WAGER_WEIGHT_SITE_CONFIG_KEYS,
    ...RAKEBACK_WAGER_WEIGHT_SITE_CONFIG_KEYS,
    ...SOURCE_WAGER_WEIGHT_SITE_CONFIG_KEYS,
    ...SHARD_WAGER_WEIGHT_SITE_CONFIG_KEYS,
  ]);
  const config = allConfig.filter((row) => !movedKeys.has(row.key));
  const hasMovedKeys = allConfig.some((row) =>
    RAIN_CONFIG_SITE_CONFIG_KEYS.includes(row.key),
  );

  // Non-critical: the wager-requirement backend branch may not be deployed
  // yet. Read it in its own try/catch → null on any failure so the card
  // renders its muted "awaiting backend deploy" state instead of crashing
  // /security.
  let wagerDefaults: WagerRequirementDefaults | null = null;
  try {
    wagerDefaults = await getWagerRequirementDefaults();
  } catch {
    wagerDefaults = null;
  }

  // Same non-critical pattern for the leaderboard wager weights — the
  // backend branch may not be deployed yet.
  let leaderboardWeights: LeaderboardWagerWeights | null = null;
  try {
    leaderboardWeights = await getLeaderboardWagerWeights();
  } catch {
    leaderboardWeights = null;
  }

  // Same non-critical pattern for the rakeback wager weights — the backend
  // branch may not be deployed yet.
  let rakebackWeights: RakebackWagerWeights | null = null;
  try {
    rakebackWeights = await getRakebackWagerWeights();
  } catch {
    rakebackWeights = null;
  }

  // Same non-critical pattern for the funding-source wager weights — the
  // backend branch may not be deployed yet.
  let sourceWeights: SourceWagerWeights | null = null;
  try {
    sourceWeights = await getSourceWagerWeights();
  } catch {
    sourceWeights = null;
  }

  // Same non-critical pattern for the per-game shard wager weights — the
  // backend branch may not be deployed yet.
  let shardWeights: ShardWagerWeights | null = null;
  try {
    shardWeights = await getShardWagerWeights();
  } catch {
    shardWeights = null;
  }

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Lock}
          title="Security"
          subtitle="Country restrictions, brute-force protection, and platform lockdown controls."
        />
      </PageHero>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Banknote} title="Withdrawal Wager Requirements" />
          <WagerRequirementCard initial={wagerDefaults} />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Trophy} title="Leaderboard Wager Weights" />
          <LeaderboardWagerWeightsCard initial={leaderboardWeights} />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Percent} title="Rakeback Wager Weights" />
          <RakebackWagerWeightsCard initial={rakebackWeights} />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Gem} title="Shard Wager Weights" />
          <ShardWagerWeightsCard initial={shardWeights} />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Coins} title="Funding-Source Wager Weights" />
          <SourceWagerWeightsCard initial={sourceWeights} />
        </div>
      </FadeIn>

      <FadeIn>
        <SecurityContent config={config} rainConfigMoved={hasMovedKeys} />
      </FadeIn>
    </div>
  );
}
