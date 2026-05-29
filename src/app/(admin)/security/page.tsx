import { Lock } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getSiteConfig } from "@/lib/queries/security";
import { SecurityContent } from "./security-content";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Security" };

export default async function SecurityPage() {
  await requirePageAccess("/security");
  const config = await getSiteConfig();

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
        <SecurityContent config={config} />
      </FadeIn>
    </div>
  );
}
