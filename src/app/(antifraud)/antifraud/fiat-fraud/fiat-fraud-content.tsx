import { Suspense } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";

import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import {
  PaginationSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { SectionHeading } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getFiatEmailCatchUsers,
  type FiatEmailCatchUserList,
} from "@/lib/antifraud/fiat-email-catches-api";
import {
  REWARD_QUERY_TIMEOUT_MS,
  safeQuery,
} from "@/lib/errors/safe-query";
import { getFiatFraudUserDepositTotals } from "@/lib/queries/fiat-fraud";
import { FiatFraudTable, type FiatFraudUserRow } from "./fiat-fraud-table";

export function FiatFraudContent({
  page,
  perPage,
  params,
}: {
  page: number;
  perPage: number;
  params: Record<string, string | undefined>;
}) {
  const sectionKey = [
    page,
    perPage,
    params.search ?? "",
    params.riskType ?? "",
    params.source ?? "",
    params.lockStatus ?? "",
  ].join("|");

  return (
    <>
      <Suspense fallback={<Skeleton className="h-10 w-full" />}>
        <DataTableToolbar
          searchPlaceholder="Search user, checkout email, or deposit ID..."
          filters={[
            {
              name: "Signal",
              paramKey: "riskType",
              options: [
                {
                  label: "Blocked email domain",
                  value: "blacklisted_domain",
                },
                {
                  label: "Dot-fragmented Gmail",
                  value: "gmail_dot_fragmentation",
                },
                {
                  label: "Suspicious deposit cluster",
                  value: "suspicious_deposit_cluster",
                },
              ],
            },
            {
              name: "Containment",
              paramKey: "lockStatus",
              options: [
                { label: "Withdrawals locked", value: "locked" },
                { label: "Lock pending", value: "pending" },
              ],
            },
            {
              name: "Source",
              paramKey: "source",
              options: [
                { label: "Whop checkout", value: "whop_checkout" },
                { label: "Signup", value: "signup" },
              ],
            },
          ]}
        />
      </Suspense>

      <div className="space-y-3">
        <SectionHeading
          icon={ShieldAlert}
          title="Caught fiat deposit users"
        />
        <p className="text-xs text-muted-foreground">
          One row per caught user with every fraud signal grouped together.
          Durable fraud catches remain here even if a blacklist rule changes
          later.
        </p>
        <Suspense
          key={sectionKey}
          fallback={
            <>
              <TableSkeleton rows={10} columns={7} />
              <PaginationSkeleton />
            </>
          }
        >
          <FiatFraudList
            page={page}
            perPage={perPage}
            search={params.search}
            riskType={params.riskType}
            source={params.source}
            lockStatus={params.lockStatus}
          />
        </Suspense>
      </div>
    </>
  );
}

async function FiatFraudList({
  page,
  perPage,
  search,
  riskType,
  source,
  lockStatus,
}: {
  page: number;
  perPage: number;
  search?: string;
  riskType?: string;
  source?: string;
  lockStatus?: string;
}) {
  const empty: FiatEmailCatchUserList = {
    data: [],
    page,
    limit: perPage,
    total: 0,
    pages: 0,
  };
  const catches = await safeQuery(
    () =>
      getFiatEmailCatchUsers({
        page,
        limit: perPage,
        search,
        riskType,
        source,
        lockStatus,
      }),
    empty,
    "transactions.fiat-fraud.catch-users",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (catches.error) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" />
        <div>
          <p className="text-sm font-medium text-red-700 dark:text-red-300">
            Fiat fraud history is unavailable
          </p>
          <p className="mt-0.5 text-xs text-red-700/80 dark:text-red-300/80">
            The Antifraud monitor did not return durable catch records. Refresh
            to retry.
          </p>
        </div>
      </div>
    );
  }

  const userIds = catches.data.data.map((row) => row.userId);
  const totals = await safeQuery(
    () => getFiatFraudUserDepositTotals(userIds),
    [],
    "transactions.fiat-fraud.user-deposit-totals",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const totalsByUserId = new Map(
    totals.data.map((total) => [total.userId, total]),
  );
  const rows: FiatFraudUserRow[] = catches.data.data.map((row) => ({
    ...row,
    depositTotals: totalsByUserId.get(row.userId) ?? null,
  }));

  return (
    <>
      {totals.error && rows.length > 0 && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Users loaded, but their total fiat deposit amounts are temporarily
            unavailable.
          </p>
        </div>
      )}
      <FiatFraudTable rows={rows} />
      <DataTablePagination
        page={catches.data.page}
        totalPages={catches.data.pages}
        total={catches.data.total}
        perPage={catches.data.limit}
      />
    </>
  );
}
