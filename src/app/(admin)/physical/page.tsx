import { Suspense } from "react";
import {
  Package,
  Hourglass,
  Truck,
  PackageCheck,
  ArrowUpFromLine,
  ListChecks,
  SlidersHorizontal,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  getPhysicalAvailability,
  getPhysicalWithdrawalStats,
  type PhysicalAvailability,
  type PhysicalWithdrawalStats,
} from "@/lib/queries/physical-withdrawals";
import { getWithdrawals } from "@/lib/queries/withdrawals";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/loading-skeletons";
import { formatCurrency } from "@/lib/utils/format";
import { PhysicalControls } from "./physical-controls";
import { WithdrawalsDataTable } from "@/app/(admin)/withdrawals/data-table";
import { columns as withdrawalsColumns } from "@/app/(admin)/withdrawals/columns";

export const metadata = { title: "Physical Withdrawals" };

// Shell-first: PageHero paints immediately; each data block streams behind
// its own <Suspense> so the heavy reads never block first paint.
export default async function PhysicalPage() {
  await requirePageAccess("/physical");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Package}
          title="Physical Withdrawals"
          subtitle="Real-world card shipments — availability controls and the fulfillment queue."
        />
      </PageHero>

      <div className="space-y-3">
        <SectionHeading icon={SlidersHorizontal} title="Availability" />
        <Suspense fallback={<Skeleton className="h-44 w-full rounded-2xl" />}>
          <AvailabilitySection />
        </Suspense>
      </div>

      <Suspense
        fallback={
          <div className="grid gap-2.5 sm:gap-4 grid-cols-2 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-2xl" />
            ))}
          </div>
        }
      >
        <StatsSection />
      </Suspense>

      <div className="space-y-3">
        <SectionHeading icon={ListChecks} title="Fulfillment queue" />
        <Suspense fallback={<TableSkeleton rows={6} columns={7} />}>
          <QueueSection />
        </Suspense>
      </div>
    </div>
  );
}

async function AvailabilitySection() {
  const fallback: PhysicalAvailability = {
    physicalCountriesAllowed: 0,
    totalCountries: 0,
  };
  const res = await safeQuery(
    () => getPhysicalAvailability(),
    fallback,
    "physical.availability",
    REWARD_QUERY_TIMEOUT_MS,
  );
  return <PhysicalControls availability={res.data} />;
}

async function StatsSection() {
  const fallback: PhysicalWithdrawalStats = {
    total: 0,
    pending: 0,
    processing: 0,
    shipped: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    totalValueUsd: 0,
  };
  const res = await safeQuery(
    () => getPhysicalWithdrawalStats(),
    fallback,
    "physical.stats",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const s = res.data;

  return (
    <FadeIn>
      <div className="grid gap-2.5 sm:gap-4 grid-cols-2 lg:grid-cols-5">
        <KpiTile label="Total requests" value={String(s.total)} icon={Package} accent="blue" />
        <KpiTile
          label="Open"
          value={String(s.pending + s.processing)}
          icon={Hourglass}
          accent="amber"
        />
        <KpiTile label="Shipped" value={String(s.shipped)} icon={Truck} accent="cyan" />
        <KpiTile
          label="Completed"
          value={String(s.completed)}
          icon={PackageCheck}
          accent="emerald"
        />
        {/* House-POV: value shipped out = money leaving the house → rose. */}
        <KpiTile
          label="Total value"
          value={formatCurrency(s.totalValueUsd)}
          icon={ArrowUpFromLine}
          accent="rose"
        />
      </div>
    </FadeIn>
  );
}

async function QueueSection() {
  const EMPTY = {
    data: [] as Awaited<ReturnType<typeof getWithdrawals>>["data"],
    total: 0,
    page: 1,
    perPage: 50,
    totalPages: 0,
  };
  const res = await safeQuery(
    () => getWithdrawals({ method: "physical", page: 1, perPage: 50 }),
    EMPTY,
    "physical.queue",
    REWARD_QUERY_TIMEOUT_MS,
  );
  return (
    <FadeIn>
      <WithdrawalsDataTable columns={withdrawalsColumns} data={res.data.data} />
    </FadeIn>
  );
}
