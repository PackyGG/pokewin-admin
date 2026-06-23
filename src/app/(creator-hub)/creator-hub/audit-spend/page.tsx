import { Suspense } from "react";
import { Receipt, ListOrdered, Coins } from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { HubKpiBox } from "../_components/hub-kpi-box";
import { BucketFilter } from "./_components/bucket-filter";
import { SpendTable } from "./_components/spend-table";
import { getAuditSpendPage } from "./_queries/get-data";
import {
  SPEND_BUCKET_KEYS,
  spendBucketLabel,
  type SpendBucketKey,
} from "./_queries/spend-events";

export const metadata = { title: "Audit Spend · Creator Hub" };

function parseBucket(raw: string | undefined): SpendBucketKey {
  if (!raw) return "all";
  return (SPEND_BUCKET_KEYS as readonly string[]).includes(raw)
    ? (raw as SpendBucketKey)
    : "all";
}

function parsePage(raw: string | undefined): number {
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 100_000) return 1; // guard against `?page=1e10`
  return n;
}

/**
 * Creator Hub — Audit Spend.
 *
 * Lifetime ledger of every creator-related cashflow event. One row per
 * event, sorted DESC by date.
 *
 * Sources:
 *   • MAIN ledger_transactions (creator_multiplier_*,
 *     affiliate_leaderboard_creation/prize)
 *   • MAIN vouchers (creator_fill_conversion grouped per (day, fill)
 *     — surfaces the RETURN-SIDE of every fill, owner directive
 *     2026-06-23. Activation/spend cost rows are intentionally hidden.)
 *   • ADMIN expenses (creator/marketing-categorized)
 *
 * Shell-first: hero + filter chips paint immediately, the table loads
 * behind a Suspense boundary keyed on `(bucket, page)` so chip switches
 * + pagination both show skeleton during the swap.
 */
export default async function CreatorHubAuditSpendPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const sp = await searchParams;
  const bucket = parseBucket(sp.bucket);
  const page = parsePage(sp.page);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Receipt}
          accent="rose"
          title="Audit Spend"
          subtitle="Lifetime ledger of every creator cashflow — leaderboard payouts, multiplier deals, expenses, and per-fill conversions as they realize."
        />
      </PageHero>

      <div className="space-y-3">
        <SectionHeading icon={ListOrdered} title="Filter by event type" />
        <BucketFilter active={bucket} />
      </div>

      <Suspense
        key={`${bucket}-${page}`}
        fallback={<AuditSpendSkeleton />}
      >
        <AuditSpendSection bucket={bucket} page={page} />
      </Suspense>
    </div>
  );
}

async function AuditSpendSection({
  bucket,
  page,
}: {
  bucket: SpendBucketKey;
  page: number;
}) {
  const { data, error, kind } = await getAuditSpendPage(bucket, page);

  // Narrow the bucket → non-"all" label key for the per-bucket copy.
  const labeledBucket =
    bucket === "all" ? null : (bucket as Exclude<SpendBucketKey, "all">);

  // Fill bucket = the only INFLOW bucket (return-side of the fill cost).
  // Adapt the KPI / section copy so it doesn't read as "spend" / "cost"
  // on that surface — and switch the lifetime KPI to emerald to match
  // the row colors. Other buckets are unchanged.
  const isFill = bucket === "fill";
  const lifetimeLabel = isFill ? "Lifetime converted" : "Lifetime spend";
  const lifetimeAccent: "rose" | "emerald" = isFill ? "emerald" : "rose";
  const lifetimeSub = isFill
    ? "Sum of every fill conversion voucher"
    : labeledBucket == null
      ? "All creator-cost events"
      : `${spendBucketLabel(labeledBucket)} events`;
  const totalEventsLabel = isFill ? "Conversion rows" : "Total events";
  const totalEventsSub = isFill
    ? "One per (day, fill) — DESC"
    : labeledBucket == null
      ? "Across every source"
      : `In ${spendBucketLabel(labeledBucket).toLowerCase()}`;
  const sectionTitle = isFill
    ? "Fill conversions per day"
    : labeledBucket == null
      ? "All spend events"
      : `${spendBucketLabel(labeledBucket)} events`;

  return (
    <FadeIn className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <HubKpiBox
          label={lifetimeLabel}
          icon={Coins}
          accent={lifetimeAccent}
          value={
            data.lifetimeTotalUsd == null
              ? "—"
              : formatCurrency(data.lifetimeTotalUsd)
          }
          sub={lifetimeSub}
          placeholder={data.lifetimeTotalUsd == null}
        />
        <HubKpiBox
          label={totalEventsLabel}
          icon={ListOrdered}
          accent="blue"
          value={formatNumber(data.total)}
          sub={totalEventsSub}
        />
        <HubKpiBox
          label="On this page"
          icon={Receipt}
          accent="blue"
          value={formatNumber(data.rows.length)}
          sub={`Page ${data.page} of ${Math.max(1, data.totalPages)}`}
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Receipt} title={sectionTitle} />
        <SpendTable
          bucket={bucket}
          data={data}
          error={error}
          kind={kind}
        />
      </div>
    </FadeIn>
  );
}

function AuditSpendSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-2xl" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[84px] rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-[56px] rounded-2xl" />
    </div>
  );
}
