import Link from "next/link";
import { Suspense } from "react";
import { Ticket, Coins, CheckCircle2, Clock } from "lucide-react";
import { getVouchers, getVoucherCreators } from "@/lib/queries/vouchers";
import { requirePageAccess } from "@/lib/dal";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { ValueRangeFilter } from "./value-range-filter";
import { VouchersTable } from "./vouchers-table";
import {
  PageHero,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Vouchers" };

export default async function VouchersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/vouchers");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const tab = params.tab || "unclaimed";

  const claimed = tab === "claimed";

  const [result, creators] = await Promise.all([
    getVouchers({
      page,
      perPage,
      claimed,
      search: params.search,
      minValue: params.minValue ? Number(params.minValue) : undefined,
      maxValue: params.maxValue ? Number(params.maxValue) : undefined,
      createdBy: params.createdBy,
    }),
    getVoucherCreators(),
  ]);

  const createdByOptions = [
    { label: "System", value: "system" },
    ...creators.map((c) => ({ label: c.username, value: c.id })),
  ];

  const pageValue = result.data.reduce((sum, v) => sum + v.value, 0);
  const ftdCount = result.data.filter((v) => v.isFtd).length;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Ticket className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Vouchers</h1>
            <p className="text-sm text-muted-foreground">
              Track issued vouchers and claim history across the platform.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label={claimed ? "Claimed Total" : "Unclaimed Total"}
          value={String(result.total)}
          icon={Ticket}
          accent="blue"
        />
        {/* Vouchers are unspent credits the house owes users — page value
            is a liability line, so it's colored rose (house loss) per
            CLAUDE.md. */}
        <KpiTile
          label="Page Value"
          value={formatCurrency(pageValue)}
          icon={Coins}
          accent="rose"
        />
        <KpiTile
          label="On Page"
          value={String(result.data.length)}
          icon={claimed ? CheckCircle2 : Clock}
          accent={claimed ? "purple" : "amber"}
        />
        {claimed && (
          <KpiTile
            label="First-Time (page)"
            value={String(ftdCount)}
            icon={CheckCircle2}
            accent="pink"
          />
        )}
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Ticket} title="Voucher List" />

        <div className="flex gap-1 rounded-lg bg-muted p-1 w-fit">
          {[
            { value: "unclaimed", label: "Unclaimed" },
            { value: "claimed", label: "Claimed" },
          ].map((t) => (
            <Link
              key={t.value}
              href={`/vouchers?tab=${t.value}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>

        <FadeIn className="space-y-4">
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <DataTableToolbar
              searchPlaceholder="Search by username or email..."
              filters={[
                {
                  name: "Created By",
                  paramKey: "createdBy",
                  options: createdByOptions,
                },
              ]}
            >
              <ValueRangeFilter />
            </DataTableToolbar>
          </Suspense>

          <VouchersTable data={result.data} claimed={claimed} />

          <DataTablePagination
            page={result.page}
            totalPages={result.totalPages}
            total={result.total}
            perPage={result.perPage}
          />
        </FadeIn>
      </div>
    </div>
  );
}
