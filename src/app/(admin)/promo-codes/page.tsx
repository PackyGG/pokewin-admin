import { Suspense } from "react";
import {
  Ticket,
  CheckCircle2,
  Clock,
  Users,
  HandCoins,
  Wallet,
} from "lucide-react";
import { getPromoCodes, getPromoCodesListStats } from "@/lib/queries/promo-codes";
import { getPromoCodesMoneyStats } from "@/lib/queries/promo-codes-stats";
import { safeQuery } from "@/lib/errors/safe-query";
import { formatCurrency } from "@/lib/utils/format";
import { requirePageAccess } from "@/lib/dal";
import { PromoCodesDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { CreatePromoCodeButton } from "./create-button";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Promo Codes" };

export default async function PromoCodesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/promo-codes");
  const params = await searchParams;

  // Stats stay stable across the region / status filter — admins get a
  // fixed read-out of the promo-code pool while they refine the table on
  // screen. Awaited up-front; the table streams in behind a keyed
  // <Suspense> so a filter / page change shows a table skeleton instead
  // of blocking the page on the previous render.
  //
  // Money stats are lifetime aggregates (no timeframe). Wrapped in
  // safeQuery so a slow / failing aggregate degrades the two money tiles
  // to "—" instead of crashing the page; the count tiles + table still
  // render.
  const [stats, { data: money }] = await Promise.all([
    getPromoCodesListStats(),
    safeQuery(
      () => getPromoCodesMoneyStats(),
      null as Awaited<ReturnType<typeof getPromoCodesMoneyStats>> | null,
      "promoCodes.moneyStats",
    ),
  ]);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Ticket}
          title="Promo Codes"
          subtitle="Manage promotional codes — track usage, restrictions, and expirations."
          action={<CreatePromoCodeButton />}
        />
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Total Codes"
          value={String(stats.totalCodes)}
          icon={Ticket}
          accent="blue"
        />
        <KpiTile
          label="Active"
          value={String(stats.activeCount)}
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Expired"
          value={String(stats.expiredCount)}
          icon={Clock}
          accent="rose"
        />
        <KpiTile
          label="Redemptions"
          value={String(stats.totalRedemptions)}
          icon={Users}
          accent="purple"
        />
      </div>

      {/* Lifetime promo-code money strip. House-POV: promo value handed to
          users is a house COST → rose headline. "Given out / claimed" is
          sourced from the immutable ledger (promo_code_redeemed) so it
          includes deleted / old codes; "Allocated / offered" is Σ(value ×
          max_uses) over CURRENT codes only (deleted codes' allocation is
          unrecoverable) — labelled as such. Both degrade to "—" via
          safeQuery. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <KpiTile
          label="Given out / claimed"
          value={money ? formatCurrency(money.claimedGivenOut) : "—"}
          sub="Realized house cost · all codes incl. deleted"
          icon={HandCoins}
          accent="rose"
        />
        <KpiTile
          label="Allocated / offered"
          value={money ? formatCurrency(money.allocatedOffered) : "—"}
          sub="Budget put up · current codes only"
          icon={Wallet}
          accent="blue"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Ticket} title="All Codes" />
        <div className="space-y-4">
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <DataTableToolbar
              searchPlaceholder="Search promo codes..."
              filters={[
                {
                  name: "Status",
                  paramKey: "status",
                  options: [
                    { label: "Active", value: "active" },
                    { label: "Expired", value: "expired" },
                  ],
                },
              ]}
            />
          </Suspense>
          {/* Keyed on the table inputs so a filter / page change re-shows
              the table skeleton instead of blocking on the previous
              render — matches the rain / rewards pattern. */}
          <Suspense
            key={`${params.status ?? ""}|${params.region ?? ""}|${params.page ?? "1"}|${params.perPage ?? "20"}`}
            fallback={
              <>
                <TableSkeleton rows={12} columns={7} />
                <PaginationSkeleton />
              </>
            }
          >
            <PromoCodesListAsync params={params} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

async function PromoCodesListAsync({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const result = await getPromoCodes({
    page,
    perPage,
    region: params.region,
    status: params.status,
  });

  return (
    <>
      <FadeIn>
        <PromoCodesDataTable data={result.data} />
      </FadeIn>
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </>
  );
}
