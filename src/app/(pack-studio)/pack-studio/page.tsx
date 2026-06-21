import { LayoutDashboard } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";

/**
 * Pack Studio — Overview. Scaffold placeholder: gated by
 * `requirePackStudioPageAccess` (owner OR per-role ADMIN-DB toggle), renders
 * a PageHero + a short "coming soon" body so the route group renders cleanly
 * while the real tooling is built out.
 */
export default async function PackStudioOverviewPage() {
  await requirePackStudioPageAccess();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={LayoutDashboard}
          accent="purple"
          title="Pack Studio"
          subtitle="Design, audit, and tune packs and cards in one workspace."
        />
      </PageHero>
      <p className="text-sm text-muted-foreground">
        Pack Studio is coming soon — pick a tool from the sidebar.
      </p>
    </div>
  );
}
