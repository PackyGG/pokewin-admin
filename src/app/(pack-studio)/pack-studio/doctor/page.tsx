import { Stethoscope } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";

/**
 * Pack Studio — Pack Doctor. Scaffold placeholder gated by
 * `requirePackStudioPageAccess`; renders a PageHero + a short "coming soon"
 * body while the real tooling is built out.
 */
export default async function PackDoctorPage() {
  await requirePackStudioPageAccess();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Stethoscope}
          accent="purple"
          title="Pack Doctor"
          subtitle="Diagnose pack edge, EV, and configuration health."
        />
      </PageHero>
      <p className="text-sm text-muted-foreground">
        Pack Doctor is coming soon.
      </p>
    </div>
  );
}
