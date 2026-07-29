import { Suspense } from "react";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { sessionHasRole } from "@/lib/dal";
import { isOwner } from "@/lib/owners";
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
import { loadPackBuilderDraft } from "./draft-data";
import { BuilderSkeleton } from "./builder-skeleton";

export const metadata = { title: "Pack Builder" };

/**
 * Pack Studio — Pack Builder. Single-page design-a-pack flow gated by
 * `requirePackStudioPageAccess`. Shell-first: the hero paints immediately while
 * the form (which needs the card-set/rarity filters + the configured max-win
 * cap) streams behind a `<Suspense>` boundary. All reads here are light + MAIN
 * read-only (sets/rarities) or ADMIN read-only (max-win cap); the heavy card
 * search runs client-side on demand via the builder's own server action, and
 * a saved draft stays in ADMIN staging, while live requests go through the
 * owner queue. Nothing is created in MAIN until a live request is approved.
 */

async function BuilderBody({
  canBuild,
  draftId,
  actorId,
  canManageAllDrafts,
}: {
  canBuild: boolean;
  draftId: string | null;
  actorId: string;
  canManageAllDrafts: boolean;
}) {
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
    initialDraft,
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
    draftId
      ? loadPackBuilderDraft({
          requestId: draftId,
          actorId,
          canManageAll: canManageAllDrafts,
        })
      : Promise.resolve(null),
  ]);
  if (draftId && !initialDraft) notFound();
  const rarities = raritiesRaw.filter((x): x is string => x != null);

  return (
    <PackBuilderForm
      key={initialDraft?.id ?? "new"}
      sets={sets}
      rarities={rarities}
      defaultMaxWinCap={maxWinCap}
      maxMultCeiling={maxMultCeiling}
      edgeCurve={edgeCurve}
      canBuild={canBuild}
      initialDraft={initialDraft}
    />
  );
}

type PackBuilderPageProps = {
  searchParams: Promise<{ draft?: string | string[] }>;
};

export default async function PackBuilderPage({
  searchParams,
}: PackBuilderPageProps) {
  const session = await requirePackStudioPageAccess();
  const rawDraftId = (await searchParams).draft;
  const draftValue = Array.isArray(rawDraftId) ? rawDraftId[0] : rawDraftId;
  const parsedDraftId = draftValue
    ? z.string().uuid().safeParse(draftValue)
    : null;
  if (parsedDraftId && !parsedDraftId.success) notFound();
  const draftId = parsedDraftId?.success ? parsedDraftId.data : null;
  const canBuild =
    isPackStudioRetuneOperator(session) ||
    sessionHasRole(session, "pack_creator");
  const canManageAllDrafts =
    isOwner(session) || sessionHasRole(session, "admin");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <Suspense fallback={<BuilderSkeleton />}>
        <BuilderBody
          canBuild={canBuild}
          draftId={draftId}
          actorId={session.userId}
          canManageAllDrafts={canManageAllDrafts}
        />
      </Suspense>
    </div>
  );
}
