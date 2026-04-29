import { Suspense } from "react";
import Link from "next/link";
import { Receipt } from "lucide-react";
import { getTransactions } from "@/lib/queries/transactions";
import { requirePageAccess } from "@/lib/dal";
import { TransactionsDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { ValueRangeFilter } from "@/app/(admin)/withdrawals/value-range-filter";
import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton, PaginationSkeleton } from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Transactions" };

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const TX_TYPES = [
  { label: "Deposit", value: "deposit" },
  { label: "Pack Opening", value: "pack_opening" },
  { label: "Battle Bet", value: "battle_bet" },
  { label: "Battle Sponsorship", value: "battle_sponsorship" },
  { label: "Battle Refund", value: "battle_refund" },
  { label: "Card Sale", value: "card_sale" },
  { label: "Card Exchange", value: "card_exchange" },
  { label: "Voucher Redeemed", value: "voucher_redeemed" },
  { label: "Gift Card", value: "gift_card_redeemed" },
  { label: "Promo Code", value: "promo_code_redeemed" },
  { label: "Rakeback", value: "rakeback_claim" },
  { label: "Race Prize", value: "race_prize" },
  { label: "Affiliate Claim", value: "affiliate_claim" },
  { label: "Admin Adjustment", value: "admin_balance_adjustment" },
  { label: "Rain Tip", value: "rain_tip" },
  { label: "Rain Win", value: "rain_win" },
  { label: "Vault Lock", value: "vault_lock" },
  { label: "Vault Unlock", value: "vault_unlock" },
  { label: "Shipping Fee", value: "withdrawal_shipping_fee" },
];

/**
 * Streaming server component for the transactions table. The expensive
 * `getTransactions` query (which joins game_sessions + provably_fair_results
 * + user_inventory) runs inside a Suspense boundary so the hero/tabs/toolbar
 * can flush to the browser immediately while the table loads.
 */
async function TransactionsContent({
  page,
  perPage,
  tab,
  search,
  type,
  minAmount,
  maxAmount,
}: {
  page: number;
  perPage: number;
  tab: string;
  search?: string;
  type?: string;
  minAmount?: number;
  maxAmount?: number;
}) {
  const result = await getTransactions({
    page,
    perPage,
    search,
    type,
    status: tab === "all" ? undefined : tab,
    minAmount: minAmount && !isNaN(minAmount) ? minAmount : undefined,
    maxAmount: maxAmount && !isNaN(maxAmount) ? maxAmount : undefined,
  });

  return (
    <>
      <FadeIn>
        <TransactionsDataTable data={result.data} />
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

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/transactions");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const tab = params.tab || "all";

  const minAmount = params.minValue ? Number(params.minValue) : undefined;
  const maxAmount = params.maxValue ? Number(params.maxValue) : undefined;

  // The Suspense key forces a fresh boundary whenever the inputs change,
  // so navigating between tabs/pages re-shows the skeleton instead of
  // freezing on the previous render.
  const suspenseKey = `${tab}|${page}|${perPage}|${params.type ?? ""}|${params.search ?? ""}|${params.minValue ?? ""}|${params.maxValue ?? ""}`;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Receipt className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Transactions</h1>
            <p className="text-sm text-muted-foreground">
              Every ledger-backed movement — filter by status, type, or value.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="space-y-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {STATUS_TABS.map((t) => (
            <Link
              key={t.value}
              href={`/transactions?tab=${t.value}${params.type ? `&type=${params.type}` : ""}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>
        <Suspense fallback={<Skeleton className="h-10 w-full" />}>
          <DataTableToolbar
            searchPlaceholder="Search by user ID, username, or transaction ID..."
            filters={[
              {
                name: "Type",
                paramKey: "type",
                options: TX_TYPES,
              },
            ]}
          >
            <ValueRangeFilter />
          </DataTableToolbar>
        </Suspense>
        <Suspense
          key={suspenseKey}
          fallback={
            <>
              <TableSkeleton rows={15} columns={7} />
              <PaginationSkeleton />
            </>
          }
        >
          <TransactionsContent
            page={page}
            perPage={perPage}
            tab={tab}
            search={params.search}
            type={params.type}
            minAmount={minAmount}
            maxAmount={maxAmount}
          />
        </Suspense>
      </div>
    </div>
  );
}
