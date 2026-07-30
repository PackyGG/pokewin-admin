import { Suspense } from "react";
import { RotateCcw } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { TableSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { canManageAntifraud } from "@/lib/antifraud/access";
import { safeQuery } from "@/lib/errors/safe-query";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import {
  getRecentRefundBatches,
  getRefundCandidates,
} from "@/lib/queries/whop-refunds";
import { PanelErrorBoundary } from "../_components/panel-error-boundary";
import { RefundsPanel } from "./refunds-panel";

export const metadata = { title: "Whop Refunds · Antifraud" };

const QUERY_TIMEOUT_MS = 15_000;

export default async function RefundsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAntifraudPageAccess();
  const params = await searchParams;
  const payment =
    typeof params.payment === "string" &&
    /^pay_[A-Za-z0-9]+$/.test(params.payment)
      ? params.payment
      : undefined;
  const reconciliationOnly = params.scope === "paid_unreconciled";

  return (
    <div className="space-y-4">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <div className="space-y-3">
        <SectionHeading
          icon={RotateCcw}
          title="Banned and fraud-account refunds"
        />
        <Suspense
          fallback={
            <>
              <Skeleton className="h-28 w-full rounded-xl" />
              <TableSkeleton rows={8} columns={4} />
            </>
          }
        >
          <RefundsSection
            requestedPaymentId={payment}
            reconciliationOnly={reconciliationOnly}
            canExecute={canManageAntifraud(session)}
          />
        </Suspense>
      </div>
    </div>
  );
}

async function RefundsSection({
  requestedPaymentId,
  reconciliationOnly,
  canExecute,
}: {
  requestedPaymentId?: string;
  reconciliationOnly: boolean;
  canExecute: boolean;
}) {
  // Isolated, not a bare Promise.all: the candidate list and the batch history
  // are independent panels, so a fault in either must not take the other down
  // with it. Both are money-facing, so a failure degrades LOUDLY (banner below)
  // — an empty refund queue rendered as if it were real would read as "nothing
  // to refund" and is the one wrong answer this page must never give.
  const [candidatesResult, batchesResult] = await Promise.all([
    safeQuery(
      () => getRefundCandidates(),
      [] as Awaited<ReturnType<typeof getRefundCandidates>>,
      "antifraud.refund-candidates",
      QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRecentRefundBatches(),
      [] as Awaited<ReturnType<typeof getRecentRefundBatches>>,
      "antifraud.refund-batches",
      QUERY_TIMEOUT_MS,
    ),
  ]);

  const candidates = candidatesResult.data;
  const visibleCandidates = reconciliationOnly
    ? candidates.filter((candidate) => candidate.status === "paid_unreconciled")
    : candidates;

  return (
    <>
      {candidatesResult.error !== null && (
        <DegradedNotice
          title="The refund queue could not be loaded"
          detail={
            candidatesResult.kind === "timeout"
              ? "The candidate read timed out. This list is EMPTY because of that failure, not because there is nothing to refund — refresh before concluding anything."
              : "The candidate read failed. This list is EMPTY because of that failure, not because there is nothing to refund."
          }
        />
      )}
      {batchesResult.error !== null && (
        <DegradedNotice
          title="Recent refund batches could not be loaded"
          detail={
            batchesResult.kind === "timeout"
              ? "The batch-history read timed out. Past batches are hidden, but the queue above is unaffected."
              : "The batch-history read failed. Past batches are hidden, but the queue above is unaffected."
          }
        />
      )}
      <PanelErrorBoundary label="Refund queue">
        <RefundsPanel
          candidates={visibleCandidates}
          recentBatches={batchesResult.data}
          requestedPaymentId={requestedPaymentId}
          reconciliationOnly={reconciliationOnly}
          canExecute={canExecute && candidatesResult.error === null}
        />
      </PanelErrorBoundary>
    </>
  );
}

/**
 * Loud degradation for a money surface. Refunds move real funds, so a read
 * failure is stated outright rather than smoothed into an empty state, and
 * execution is disabled while the queue is untrustworthy.
 */
function DegradedNotice({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div
      role="status"
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3"
    >
      <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
        {title}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}
