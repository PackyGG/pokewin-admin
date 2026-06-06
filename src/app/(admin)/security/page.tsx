import { Lock, Banknote } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getSiteConfig } from "@/lib/queries/security";
import { SecurityContent } from "./security-content";
import { PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { RAIN_CONFIG_SITE_CONFIG_KEYS } from "../rain/config-keys";
import { WAGER_REQUIREMENT_SITE_CONFIG_KEYS } from "./wager-requirement-keys";
import { WagerRequirementCard } from "./wager-requirement-card";
import {
  getWagerRequirementDefaults,
  type WagerRequirementDefaults,
} from "@/lib/backend-api/wager-requirements";

export const metadata = { title: "Security" };

export default async function SecurityPage() {
  await requirePageAccess("/security");
  const allConfig = await getSiteConfig();

  // Rain-specific site_config keys are managed on /rain?tab=config; the
  // withdrawal wager-requirement keys are managed by the dedicated card
  // below (written through the backend API). Hide both groups from the
  // generic config table so the same row isn't editable in two surfaces
  // (would cause confusion + duplicate audit events).
  const movedKeys = new Set<string>([
    ...RAIN_CONFIG_SITE_CONFIG_KEYS,
    ...WAGER_REQUIREMENT_SITE_CONFIG_KEYS,
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
        <SecurityContent config={config} rainConfigMoved={hasMovedKeys} />
      </FadeIn>
    </div>
  );
}
