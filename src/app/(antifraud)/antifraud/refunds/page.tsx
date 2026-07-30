import { Suspense } from "react";
import { RotateCcw } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { TableSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOwner } from "@/lib/owners";
import {
  getRecentRefundBatches,
  getRefundCandidates,
} from "@/lib/queries/whop-refunds";
import { RefundsPanel } from "./refunds-panel";

export const metadata = { title: "Whop Refunds · Antifraud" };

export default async function RefundsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwner();
  const params = await searchParams;
  const payment =
    typeof params.payment === "string" &&
    /^pay_[A-Za-z0-9]+$/.test(params.payment)
      ? params.payment
      : undefined;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <div className="space-y-3">
        <SectionHeading icon={RotateCcw} title="Flagged account refunds" />
        <Suspense
          fallback={
            <>
              <Skeleton className="h-28 w-full rounded-xl" />
              <TableSkeleton rows={8} columns={4} />
            </>
          }
        >
          <RefundsSection requestedPaymentId={payment} />
        </Suspense>
      </div>
    </div>
  );
}

async function RefundsSection({
  requestedPaymentId,
}: {
  requestedPaymentId?: string;
}) {
  const [candidates, recentBatches] = await Promise.all([
    getRefundCandidates(),
    getRecentRefundBatches(),
  ]);

  return (
    <RefundsPanel
      candidates={candidates}
      recentBatches={recentBatches}
      requestedPaymentId={requestedPaymentId}
    />
  );
}
