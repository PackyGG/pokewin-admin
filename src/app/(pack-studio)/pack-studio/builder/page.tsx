import { Suspense } from "react";
import { Wand2 } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  FormCardSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { isPackStudioRetuneOperator } from "@/lib/reprice-access";
import { getSets, getRarities } from "@/lib/queries/cards";
import {
  readMaxWinCap,
  readMaxMultCeiling,
  readEdgeCurveConfig,
  DEFAULT_MAX_WIN_CAP,
  DEFAULT_MAX_MULT_CEILING,
  DEFAULT_EDGE_CURVE,
} from "@/app/(admin)/packs/_lib/risk-config";
import { safeQuery } from "@/lib/errors/safe-query";
import { PackBuilderForm } from "./pack-builder-form";

/**
 * Pack Studio — Pack Builder. Single-page design-a-pack flow gated by
 * `requirePackStudioPageAccess`. Shell-first: the hero paints immediately while
 * the form (which needs the card-set/rarity filters + the configured max-win
 * cap) streams behind a `<Suspense>` boundary. All reads here are light + MAIN
 * read-only (sets/rarities) or ADMIN read-only (max-win cap); the heavy card
 * search runs client-side on demand via the builder's own server action, and
 * pack creation goes through the owner-gated `buildPack` action (created as an
 * inactive draft, or activated live on-site via the "Push & activate" option).
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
  // Each read is safeQuery-wrapped so a transient DB fault on ONE read degrades
  // to its safe default (the same fallbacks the config readers use internally)
  // instead of throwing the whole route into the error boundary. The form stays
  // functional: sets/rarities filter the picker (empty = "no sets/rarities yet")
  // and the caps/curve seed the live preview + auto-target math.
  //   • sets / rarities → MAIN read-only  • caps / curve → ADMIN read-only
  const [
    { data: sets },
    { data: raritiesRaw },
    { data: maxWinCap },
    { data: maxMultCeiling },
    { data: edgeCurve },
  ] = await Promise.all([
    safeQuery(
      () => getSets(),
      [] as Awaited<ReturnType<typeof getSets>>,
      "pack-studio.builder.sets",
    ),
    safeQuery(
      () => getRarities(),
      [] as Awaited<ReturnType<typeof getRarities>>,
      "pack-studio.builder.rarities",
    ),
    safeQuery(() => readMaxWinCap(), DEFAULT_MAX_WIN_CAP, "pack-studio.builder.maxWinCap"),
    safeQuery(
      () => readMaxMultCeiling(),
      DEFAULT_MAX_MULT_CEILING,
      "pack-studio.builder.maxMultCeiling",
    ),
    safeQuery(
      () => readEdgeCurveConfig(),
      DEFAULT_EDGE_CURVE,
      "pack-studio.builder.edgeCurve",
    ),
  ]);
  const rarities = raritiesRaw.filter((x): x is string => x != null);

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
  // `canBuild` matches the server-side `buildPack` gate: owners plus the
  // hard-coded Pack-Studio retune operator allowlist (see `reprice-access.ts`).
  const canBuild = isPackStudioRetuneOperator(session);

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
