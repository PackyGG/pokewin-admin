import { Suspense } from "react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { SecuritySectionsLoader } from "./security-sections-loader";

export const metadata = { title: "Security" };

/** Streaming fallback while the section fan-out resolves. */
function SectionsFallback() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
    </div>
  );
}

export default async function SecurityPage() {
  await requirePageAccess("/security");

  // The section data fan-out (one MAIN-DB scan + nine backend GETs) runs
  // inside SecuritySectionsLoader behind a <Suspense> boundary, so the shell
  // (PageHero) paints immediately while the cards stream in — instead of the
  // page holding first paint hostage to the slowest backend leg. The fan-out
  // reads are prod-cached + tag-invalidated on edit (see _cached-reads.ts).
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <FadeIn>
        <Suspense fallback={<SectionsFallback />}>
          <SecuritySectionsLoader />
        </Suspense>
      </FadeIn>
    </div>
  );
}
