import { Suspense } from "react";
import { Layers } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/fade-in";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { isPackStudioRetuneOperator } from "@/lib/reprice-access";
import { getDefaultRouteForRoles } from "@/lib/admin-roles";
import { getUserPermissions, sessionRoles } from "@/lib/dal";
import { redirect } from "next/navigation";
import { safeQueryOrNull } from "@/lib/errors/safe-query";

import {
  getPortfolioProfileFromProposals,
  planAllRetunes,
} from "../doctor/retune-actions";
import { RetuneReview } from "./retune-review";

/**
 * Server-side budget for the initial proposal compute. The dry-run runs
 * `searchBestPriceForCleanSnap` × 183 active packs — the CPU-bound work that
 * dominates this page's wall-clock cost. The page-level cache (`unstable_cache`
 * inside `planAllRetunes`) absorbs most subsequent loads; this longer ceiling
 * exists for the cold-start miss so Vercel doesn't kill the request at the
 * default 15s gateway timeout. Sized comfortably above the worst measured
 * cold-render. The cache TTL makes a hot reload sub-second.
 */
export const maxDuration = 120;

/**
 * Pack Studio — Bulk Re-tune Review. A "Tinder-style" card-stack flow: the
 * owner reviews ONE pack at a time, comparing its current risk profile against
 * the proposed auto-retune, and decides per pack — Approve (writes), Decline /
 * Skip (no write), or Adjust (re-shape the targets locally, then approve the
 * adjusted vector).
 *
 * Owner-only. Shell-first: the hero paints immediately while the proposals
 * (`planAllRetunes`, a READ-ONLY dry-run of every in-scope pack) stream behind a
 * `<Suspense>` boundary (see `loading.tsx` for the matching skeleton).
 *
 * NOTHING is persisted until the owner Approves a pack. The 2FA "Start review"
 * gate mints a single retune token (`authorizePackRetune`) that authorizes every
 * approve-write for the session; an expired token re-prompts inline. Each
 * Approve calls the existing paranoid `applyPackRetune` (re-shapes fresh +
 * writes server-side) — the only authoritative MAIN write path.
 */

async function ReviewLoader() {
  // READ-ONLY dry-run for every in-scope pack (no MAIN write). This already
  // reads every in-scope pack's card composition AND scores each pack's current
  // `before` risk — so the "System Balance" catalog profile is derived from THIS
  // result (`getPortfolioProfileFromProposals`) instead of re-running the same
  // heavy `getPacksPoolComposition` MAIN scan + config reads a second time (the
  // old `Promise.all([planAllRetunes(), getPortfolioProfile()])` double-scanned
  // the catalog on every first paint).
  //
  // Wrapped in `safeQueryOrNull` with a 90s wall-clock cap — a pathologically
  // slow proposal compute (e.g. a chain of tagged-mode price searches that each
  // sweep 320 candidates) returns the empty-state instead of hanging the segment
  // until Vercel kills the request. The CPU work itself is bounded by the per-pack
  // search cap; `unstable_cache` inside `planAllRetunes` makes hot loads
  // sub-second.
  const PROPOSAL_TIMEOUT_MS = 90_000;
  const { data, error } = await safeQueryOrNull(
    () => planAllRetunes(),
    "pack-studio.retune.plan-all",
    PROPOSAL_TIMEOUT_MS,
  );

  if (error || !data || data.proposals.length === 0) {
    return (
      <div className="rounded-md border">
        <EmptyState
          icon={Layers}
          title={error ? "Could not load proposals" : "No packs to review"}
          description={
            error
              ? "The dry-run timed out or failed. Refresh to retry."
              : "There are no active cash packs in scope for a bulk re-tune right now."
          }
        />
      </div>
    );
  }

  const { proposals } = data;
  // Catalog-level system risk profile for the "System Balance" header — derived
  // from the proposals above (no extra DB read; agrees per-card with the cards).
  const portfolio = await getPortfolioProfileFromProposals(proposals);

  return (
    <FadeIn>
      <RetuneReview proposals={proposals} portfolio={portfolio} />
    </FadeIn>
  );
}

export default async function PackRetuneReviewPage() {
  const session = await requirePackStudioPageAccess();

  // Operator-only surface: a non-operator Pack-Studio viewer is bounced to
  // their landing route (the same contract the re-price / doctor write tools
  // use). Owners always pass; the hard-coded Pack-Studio retune operator
  // allowlist (`isPackStudioRetuneOperator`) also passes.
  if (!isPackStudioRetuneOperator(session)) {
    const allowedPages = await getUserPermissions(session.userId);
    redirect(getDefaultRouteForRoles(sessionRoles(session), allowedPages));
  }

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Layers}
          accent="purple"
          title="Bulk Re-tune Review"
          subtitle="Review every cash pack's proposed auto-retune one at a time — approve, skip, or adjust."
        />
      </PageHero>

      {/* No section heading here — the loaded review renders its own "System
          balance" + "Review queue" headings (see retune-review.tsx). A heading
          at this level would duplicate the "Review queue" title. */}
      <Suspense
        fallback={
          <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
            <Skeleton className="hidden h-[28rem] rounded-xl lg:block" />
            <Skeleton className="h-[28rem] rounded-xl" />
          </div>
        }
      >
        <ReviewLoader />
      </Suspense>
    </div>
  );
}
