import { Globe } from "lucide-react";
import { requireAdmin } from "@/lib/dal";
import { getCountryRestrictions } from "@/lib/queries/geo-blocking";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { GeoBlockingContent } from "./geo-blocking-content";

export const metadata = { title: "Geo Blocking" };

/**
 * /system/geo-blocking — per-country deposit / withdrawal restrictions
 * (formerly the "Country Restrictions" section of the removed /settings
 * page). Admin-only config surface; the gate matches the old /settings page
 * (requireAdmin) and the underlying server actions enforce requireAdmin +
 * the per-action capabilities independently.
 */
export default async function GeoBlockingPage() {
  await requireAdmin();
  const countryRestrictions = await getCountryRestrictions();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Globe}
          title="Geo Blocking"
          subtitle="Per-country deposit & withdrawal restrictions and locked currencies."
        />
      </PageHero>

      <FadeIn>
        <GeoBlockingContent countryRestrictions={countryRestrictions} />
      </FadeIn>
    </div>
  );
}
