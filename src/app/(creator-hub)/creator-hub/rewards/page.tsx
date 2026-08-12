import { Suspense } from "react";
import { AlertTriangle, Crown, HandCoins, Hourglass, Inbox } from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { requirePageAccess } from "@/lib/dal";
import { FadeIn } from "@/components/fade-in";
import { KpiTile } from "@/components/modern-panels";
import {
  safeQueryOrNull,
  REWARD_QUERY_TIMEOUT_MS,
} from "@/lib/errors/safe-query";
import { getClaims, getProgramsWithStats } from "@/lib/creator-vip/queries";
import { formatCurrency } from "@/lib/utils/format";

import {
  CreatorVipContent,
  type CreatorVipTab,
} from "./content";
import { HubNotice } from "../_components/hub-notice";
import { RewardsBodySkeleton } from "./loading";

export const metadata = { title: "Creator Rewards · Creator Hub" };

/** The `getClaims` fetch limit — also drives the truncation note in the UI. */
const CLAIMS_CAP = 200;

/**
 * Creator Hub → Creator Rewards.
 *
 * The only staff surface for wager-milestone reward programs + the manual
 * claim-review queue. Its data, UI, and mutations all live with this Marketing
 * route so the normal admin dashboard has no duplicate entry point.
 *
 * On top of the shared body, the Hub adds a work-queue summary strip (pending
 * count, pending payout total, oldest pending age, active programs) computed
 * from the SAME two reads — no extra queries — and links creators to their
 * Hub pages (`/creator-hub/creators/{id}`) so the surface stays self-contained.
 * `?tab=programs|requests` is the tab, read here and rendered as `<Link>`s —
 * deep-linkable and back-navigable, the same contract the roster tabs use.
 *
 * ── ACCESS ────────────────────────────────────────────────────────────────
 * `requireCreatorHubPageAccess()` **and** `requirePageAccess("/creator-rewards")`.
 *
 * The Hub is reachable by non-admin roles via the per-role ADMIN-DB toggle,
 * and `creator`-role users hold real dashboard sessions. Gating this page on
 * Hub membership ALONE would show a creator the full claim queue (every
 * creator's pending payouts) on a page whose every button then throws — the
 * mutations in `rewards/actions.ts` are `requireAdmin()` precisely so
 * a creator can't approve payouts against their own program. So the view gate
 * remains stricter than Hub membership alone. The `requireAdmin()` write gate
 * is untouched.
 *
 * Both reads stream behind one Suspense boundary (loading.tsx shares the same
 * skeleton), each degraded independently.
 */
export default async function CreatorHubRewardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();
  await requirePageAccess("/creator-rewards");

  const rawTab = (await searchParams).tab;
  const tab: CreatorVipTab | undefined =
    rawTab === "programs" || rawTab === "requests" ? rawTab : undefined;

  return (
    <Suspense fallback={<RewardsBodySkeleton />}>
      <Body tab={tab} />
    </Suspense>
  );
}

/** "3d" / "5h" / "12m" — how long the oldest pending claim has been waiting. */
function formatAge(oldestIso: string): string {
  const ms = Date.now() - new Date(oldestIso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

async function Body({ tab }: { tab: CreatorVipTab | undefined }) {
  // Independent reads, degraded independently: a failing claims query must not
  // blank the programs table (and vice versa). `null` is the failure sentinel —
  // distinct from a successful read that genuinely found nothing.
  const [programs, claims] = await Promise.all([
    safeQueryOrNull(
      // Archived programs come along so the panel can offer "Show archived"
      // without a second read; it hides them by default.
      () => getProgramsWithStats({ includeArchived: true }),
      "creator-hub.rewards.programs",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQueryOrNull(
      () => getClaims({ limit: CLAIMS_CAP }),
      "creator-hub.rewards.claims",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  // Work-queue strip, computed from the two reads the page already holds.
  // A failed read shows "—" on its tiles rather than a confident zero.
  const pending = (claims.data ?? []).filter((c) => c.status === "pending");
  const pendingPayoutUsd = pending.reduce((sum, c) => sum + c.amountUsd, 0);
  const oldestPendingAt =
    pending.length > 0
      ? pending.reduce(
          (oldest, c) => (c.requestedAt < oldest ? c.requestedAt : oldest),
          pending[0].requestedAt,
        )
      : null;
  const activePrograms = (programs.data ?? []).filter((p) => p.isActive).length;
  // "of N total" counts what still exists as a program — an archived one is
  // retired history and can never be activated again.
  const livePrograms = (programs.data ?? []).filter(
    (p) => p.archivedAt == null,
  ).length;

  return (
    <FadeIn>
      <div className="space-y-4">
        {programs.data === null && (
          <HubNotice tone="amber" icon={AlertTriangle}>
            Couldn&apos;t load the programs — the list below may be incomplete.
            Refresh to try again.
          </HubNotice>
        )}
        {claims.data === null && (
          <HubNotice tone="amber" icon={AlertTriangle}>
            Couldn&apos;t load the claim requests — the list below may be
            incomplete. Refresh to try again.
          </HubNotice>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Pending claims"
            value={claims.data === null ? "—" : String(pending.length)}
            sub="awaiting review"
            icon={Crown}
            accent={pending.length > 0 ? "amber" : "blue"}
          />
          {/* House-POV: an approved claim pays the player, so the queued total
              is money the house is about to give away — rose. */}
          <KpiTile
            label="Pending payout"
            value={claims.data === null ? "—" : formatCurrency(pendingPayoutUsd)}
            sub="if all approved"
            icon={HandCoins}
            accent="rose"
          />
          <KpiTile
            label="Oldest pending"
            value={
              claims.data === null
                ? "—"
                : oldestPendingAt
                  ? formatAge(oldestPendingAt)
                  : "none"
            }
            sub="waiting time"
            icon={Hourglass}
            accent="amber"
          />
          <KpiTile
            label="Active programs"
            value={programs.data === null ? "—" : String(activePrograms)}
            sub={
              programs.data === null
                ? undefined
                : `of ${livePrograms} total`
            }
            icon={Inbox}
            accent="blue"
          />
        </div>

        {/* Requests is the stable first/default view. Programs remains
            explicitly deep-linkable through `?tab=programs`. */}
        <CreatorVipContent
          programs={programs.data ?? []}
          claims={claims.data ?? []}
          activeTab={tab ?? "requests"}
          basePath="/creator-hub/rewards"
          creatorHrefBase="/creator-hub/creators"
          claimsCap={CLAIMS_CAP}
        />
      </div>
    </FadeIn>
  );
}
