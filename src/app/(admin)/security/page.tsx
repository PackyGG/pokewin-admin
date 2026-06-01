import { Lock } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getSiteConfig } from "@/lib/queries/security";
import { SecurityContent } from "./security-content";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { RAIN_CONFIG_SITE_CONFIG_KEYS } from "../rain/config-keys";

export const metadata = { title: "Security" };

export default async function SecurityPage() {
  await requirePageAccess("/security");
  const allConfig = await getSiteConfig();

  // Rain-specific site_config keys are managed on /rain?tab=config so
  // the same row isn't editable in two surfaces (would cause confusion +
  // duplicate audit events). Hide them here and show a callout pointer.
  const movedKeys = new Set<string>(RAIN_CONFIG_SITE_CONFIG_KEYS);
  const config = allConfig.filter((row) => !movedKeys.has(row.key));
  const hasMovedKeys = allConfig.some((row) => movedKeys.has(row.key));

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
        <SecurityContent config={config} rainConfigMoved={hasMovedKeys} />
      </FadeIn>
    </div>
  );
}
