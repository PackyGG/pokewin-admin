import { Wand2 } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";

/**
 * Pack Studio — Pack Builder. Scaffold placeholder gated by
 * `requirePackStudioPageAccess`; renders a PageHero + a short "coming soon"
 * body while the real tooling is built out.
 */
export default async function PackBuilderPage() {
  await requirePackStudioPageAccess();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Wand2}
          accent="purple"
          title="Pack Builder"
          subtitle="Compose new packs and tune their card pools."
        />
      </PageHero>
      <p className="text-sm text-muted-foreground">
        Pack Builder is coming soon.
      </p>
    </div>
  );
}
