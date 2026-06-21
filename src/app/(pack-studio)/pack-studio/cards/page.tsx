import { Layers } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";

/**
 * Pack Studio — Card Editor. Scaffold placeholder gated by
 * `requirePackStudioPageAccess`; renders a PageHero + a short "coming soon"
 * body while the real tooling is built out.
 */
export default async function CardEditorPage() {
  await requirePackStudioPageAccess();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Layers}
          accent="purple"
          title="Card Editor"
          subtitle="Review and edit card values and metadata."
        />
      </PageHero>
      <p className="text-sm text-muted-foreground">
        Card Editor is coming soon.
      </p>
    </div>
  );
}
