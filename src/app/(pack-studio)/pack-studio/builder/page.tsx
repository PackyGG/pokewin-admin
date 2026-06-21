import { Suspense } from "react";
import { Wand2 } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  FormCardSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { isRepriceOwner } from "@/lib/reprice-access";
import { getSets, getRarities } from "@/lib/queries/cards";
import {
  readMaxWinCap,
  readMaxMultCeiling,
  readEdgeCurveConfig,
} from "../_lib/risk-config";
import { PackBuilderForm } from "./pack-builder-form";

/**
 * Pack Studio — Pack Builder. Single-page design-a-pack flow gated by
 * `requirePackStudioPageAccess`. Shell-first: the hero paints immediately while
 * the form (which needs the card-set/rarity filters + the configured max-win
 * cap) streams behind a `<Suspense>` boundary. All reads here are light + MAIN
 * read-only (sets/rarities) or ADMIN read-only (max-win cap); the heavy card
 * search runs client-side on demand via the builder's own server action, and
 * pack creation goes through the owner-gated `buildPack` action (active:false).
 */

/** Shell-matching fallback shared by the page <Suspense> and `loading.tsx`. */
export function BuilderSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <FormCardSkeleton rows={6} />
      </div>
      <div className="space-y-4">
        <KpiStripSkeleton count={4} />
        <FormCardSkeleton rows={3} />
      </div>
    </div>
  );
}

async function BuilderBody({ canBuild }: { canBuild: boolean }) {
  const [{ sets, rarities }, maxWinCap, maxMultCeiling, edgeCurve] =
    await Promise.all([
      (async () => {
        const [s, r] = await Promise.all([getSets(), getRarities()]);
        return { sets: s, rarities: r.filter((x): x is string => x != null) };
      })(),
      readMaxWinCap(),
      readMaxMultCeiling(),
      readEdgeCurveConfig(),
    ]);

  return (
    <PackBuilderForm
      sets={sets}
      rarities={rarities}
      defaultMaxWinCap={maxWinCap}
      maxMultCeiling={maxMultCeiling}
      edgeCurve={edgeCurve}
      canBuild={canBuild}
    />
  );
}

export default async function PackBuilderPage() {
  const session = await requirePackStudioPageAccess();
  const canBuild = isRepriceOwner(session);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Wand2}
          accent="purple"
          title="Pack Builder"
          subtitle="Compose a new pack, tune its feel, and watch the edge live."
        />
      </PageHero>

      <Suspense fallback={<BuilderSkeleton />}>
        <BuilderBody canBuild={canBuild} />
      </Suspense>
    </div>
  );
}
