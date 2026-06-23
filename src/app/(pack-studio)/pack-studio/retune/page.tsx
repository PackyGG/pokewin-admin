import { Suspense } from "react";
import { Layers } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/fade-in";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { isOwner } from "@/lib/owners";
import { getDefaultRouteForRoles } from "@/lib/admin-roles";
import { getUserPermissions, sessionRoles } from "@/lib/dal";
import { redirect } from "next/navigation";

import { getPortfolioProfile, planAllRetunes } from "../doctor/retune-actions";
import { RetuneReview } from "./retune-review";

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
  // READ-ONLY dry-run for every in-scope pack (no MAIN write) + the catalog-level
  // system risk profile for the "System Balance" header. Both are owner-gated,
  // read-only reads; fetched together so the surface paints in one pass.
  const [{ proposals }, portfolio] = await Promise.all([
    planAllRetunes(),
    getPortfolioProfile(),
  ]);

  if (proposals.length === 0) {
    return (
      <div className="rounded-md border">
        <EmptyState
          icon={Layers}
          title="No packs to review"
          description="There are no active cash packs in scope for a bulk re-tune right now."
        />
      </div>
    );
  }

  return (
    <FadeIn>
      <RetuneReview proposals={proposals} portfolio={portfolio} />
    </FadeIn>
  );
}

export default async function PackRetuneReviewPage() {
  const session = await requirePackStudioPageAccess();

  // Owner-only surface: a non-owner Pack-Studio viewer is bounced to their
  // landing route (the same contract the re-price / doctor write tools use).
  if (!isOwner(session)) {
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
