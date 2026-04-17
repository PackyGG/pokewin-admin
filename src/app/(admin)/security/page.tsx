import { Lock } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getSiteConfig } from "@/lib/queries/security";
import { SecurityContent } from "./security-content";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Security" };

export default async function SecurityPage() {
  await requirePageAccess("/security");
  const config = await getSiteConfig();

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Lock className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Security</h1>
            <p className="text-sm text-muted-foreground">
              Country restrictions, brute-force protection, and platform
              lockdown controls.
            </p>
          </div>
        </div>
      </PageHero>

      <FadeIn>
        <SecurityContent config={config} />
      </FadeIn>
    </div>
  );
}
