import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ClipboardEdit, Layers } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { isPackStudioRetuneOperator } from "@/lib/reprice-access";
import { getDefaultRouteForRoles } from "@/lib/admin-roles";
import { getUserPermissions, sessionRoles } from "@/lib/dal";

import {
  listPendingDrafts,
  type PendingDraftRow,
} from "@/lib/queries/pack-retune-drafts";
import { safeQuery } from "@/lib/errors/safe-query";

import {
  DraftsList,
  DraftsListSkeleton,
  DraftsTopActions,
} from "./drafts-list";

/**
 * Pack Studio — DRAFTS. Every staged retune / edit / reprice lives here as an
 * admin-DB row that mirrors the existing live math. NO 2FA. NO MAIN write
 * until the operator clicks "Push to prod" (per-row) or "Push all" (top bar) —
 * those are the ONLY writes that touch MAIN, and they wrap the existing
 * paranoid `applyPackEdit` so EDIT_EDGE_FLOOR + fresh re-read + audit all
 * still fire.
 *
 * Shell-first per CLAUDE.md: the PageHero + top-action bar paint immediately;
 * the draft list streams behind a <Suspense> boundary (matches loading.tsx).
 * The list is a cached admin-DB read (Path 1 — indexed by `status` + a partial
 * unique on `pack_id WHERE status='draft'`), no MAIN traffic.
 *
 * Owner + retune-operator allowlist (demee) only. Non-operator viewers bounce
 * to their landing route — same contract `/pack-studio/retune` uses.
 */

async function DraftsListLoader() {
  // Cached ADMIN-DB read (no MAIN traffic). safeQuery-wrapped so a transient
  // admin-DB fault degrades to the empty-drafts state instead of throwing the
  // route into its error boundary — the draft list is non-destructive and the
  // operator can simply retry.
  const { data: rows } = await safeQuery(
    () => listPendingDrafts(),
    [] as PendingDraftRow[],
    "pack-studio.drafts.list",
  );

  return (
    <div className="space-y-3">
      <SectionHeading
        icon={Layers}
        title={
          rows.length === 0
            ? "Pending drafts"
            : `Pending drafts (${rows.length})`
        }
      />
      <FadeIn>
        <DraftsList rows={rows} />
      </FadeIn>
    </div>
  );
}

/**
 * The top-bar action cluster needs the pending count to enable "Push all (N)".
 * Reads the same cached list so we don't double-query the DB.
 *
 * Kept as its own async server child so the action buttons stream alongside
 * the list — the hero + sub-text below paint instantly without it.
 */
async function DraftsTopActionsLoader() {
  // Same cached read as the list (shared cache entry — no double-query).
  // safeQuery-wrapped: on failure the count degrades to 0 (disables
  // "Push all") instead of crashing the streamed action cluster.
  const { data: rows } = await safeQuery(
    () => listPendingDrafts(),
    [] as PendingDraftRow[],
    "pack-studio.drafts.count",
  );
  return <DraftsTopActions pendingCount={rows.length} />;
}

export default async function PackDraftsPage() {
  const session = await requirePackStudioPageAccess();

  // Operator-only surface — same gate the live retune/edit tools use.
  if (!isPackStudioRetuneOperator(session)) {
    const allowedPages = await getUserPermissions(session.userId);
    redirect(getDefaultRouteForRoles(sessionRoles(session), allowedPages));
  }

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ClipboardEdit}
          accent="purple"
          title="Pack Drafts"
          subtitle="Stage retune / edit / reprice proposals against admin DB. No 2FA, no MAIN write until you push."
          action={
            <Suspense
              fallback={
                <div className="h-8 w-44 rounded-md bg-muted/60 motion-safe:animate-pulse" />
              }
            >
              <DraftsTopActionsLoader />
            </Suspense>
          }
        />
      </PageHero>

      <Suspense
        fallback={
          <div className="space-y-3">
            <div className="h-5 w-44 rounded bg-muted/60 motion-safe:animate-pulse" />
            <DraftsListSkeleton />
          </div>
        }
      >
        <DraftsListLoader />
      </Suspense>
    </div>
  );
}
