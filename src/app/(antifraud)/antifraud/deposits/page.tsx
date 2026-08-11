import { Suspense } from "react";
import { AlertTriangle, Banknote, CreditCard, MapPin } from "lucide-react";

import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { HostLink } from "@/components/host-link";
import { SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listFiatAssessments,
  type FiatAssessment,
} from "@/lib/antifraud/fiat-deposits-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { parsePage, parsePerPage } from "@/lib/utils/pagination";
import { FactCell } from "../_components/list-page";

export const metadata = { title: "Deposits · Antifraud" };

type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DepositsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAntifraudPageAccess();
  const raw = await searchParams;
  const page = parsePage(firstValue(raw.page), 10_000);
  const perPage = Math.min(parsePerPage(firstValue(raw.perPage)), 100);

  return (
    <div className="space-y-4">
      <SectionHeading icon={Banknote} title="Fiat deposits" />
      <Suspense key={`${page}-${perPage}`} fallback={<DepositsSkeleton />}>
        <DepositList page={page} perPage={perPage} />
      </Suspense>
    </div>
  );
}

async function DepositList({
  page,
  perPage,
}: {
  page: number;
  perPage: number;
}) {
  const result = await listFiatAssessments({ page, limit: perPage });

  if (!result.configured || result.error || !result.pagination) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <p className="text-sm text-amber-800 dark:text-amber-200">
          Fiat deposits are temporarily unavailable. Refresh to retry.
        </p>
      </div>
    );
  }

  return (
    <>
      {result.data.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-14 text-center text-sm text-muted-foreground">
          No Fiat deposits found.
        </div>
      ) : (
        <div className="space-y-3">
          {result.data.map((deposit) => (
            <DepositCard key={deposit.deposit_intent_id} deposit={deposit} />
          ))}
        </div>
      )}
      <DataTablePagination
        page={result.pagination.page}
        totalPages={result.pagination.pages}
        total={result.pagination.total}
        perPage={result.pagination.limit}
      />
    </>
  );
}

function DepositCard({ deposit }: { deposit: FiatAssessment }) {
  const customerPaid = deposit.customer_total_usd ?? deposit.requested_amount_usd;
  const displayName = deposit.username ?? deposit.email ?? deposit.user_id;
  const verdict = deposit.verdict === "bad"
    ? "High risk"
    : deposit.verdict === "review"
      ? "Review"
      : "Good";

  return (
    <article className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <HostLink
            href={`/users/${deposit.user_id}`}
            className="block truncate font-semibold hover:underline"
          >
            {displayName}
          </HostLink>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {deposit.user_id}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatRelative(deposit.occurred_at)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge variant="outline">{deposit.status.replaceAll("_", " ")}</Badge>
          <Badge
            variant="outline"
            className={cn(
              deposit.verdict === "bad"
                ? "border-rose-500/30 text-rose-700 dark:text-rose-300"
                : deposit.verdict === "review"
                  ? "border-amber-500/30 text-amber-700 dark:text-amber-300"
                  : "border-emerald-500/30 text-emerald-700 dark:text-emerald-300",
            )}
          >
            {verdict} · {deposit.risk_score}/100
          </Badge>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <FactCell label="Balance credit" value={formatCurrency(deposit.credited_amount_usd)} />
        <FactCell label="Customer paid" value={formatCurrency(customerPaid)} />
        <FactCell
          label="Checkout email"
          value={deposit.provider_evidence.checkoutEmail ?? "Unavailable"}
          alert={deposit.detection_evidence.checkoutEmailDiffersFromAccount}
        />
        <FactCell
          label="Checkout location"
          value={deposit.provider_evidence.billingCountry ?? "Unknown"}
          alert={deposit.detection_evidence.billingCountryMismatch}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <MapPin className="size-3.5" />
          Account {deposit.account_evidence.countryCode ?? "unknown"}
        </span>
        <HostLink
          href={`/transactions/card-payments/${deposit.deposit_intent_id}`}
          className="inline-flex items-center gap-1.5 font-medium hover:underline"
        >
          <CreditCard className="size-3.5" />
          Payment details
        </HostLink>
      </div>
    </article>
  );
}

function DepositsSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, index) => (
        <Skeleton key={index} className="h-52 w-full rounded-xl" />
      ))}
    </div>
  );
}
