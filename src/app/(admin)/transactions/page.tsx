import { Suspense } from "react";
import Link from "next/link";
import { getTransactions } from "@/lib/queries/transactions";
import { requirePageAccess } from "@/lib/dal";
import { TransactionsDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { ValueRangeFilter } from "@/app/(admin)/withdrawals/value-range-filter";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

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

  const result = await getTransactions({
    page,
    perPage,
    search: params.search,
    type: params.type,
    status: tab === "all" ? undefined : tab,
    minAmount: minAmount && !isNaN(minAmount) ? minAmount : undefined,
    maxAmount: maxAmount && !isNaN(maxAmount) ? maxAmount : undefined,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Transactions</h1>
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
      <TransactionsDataTable data={result.data} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
