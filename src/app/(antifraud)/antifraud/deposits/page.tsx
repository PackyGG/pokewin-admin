import { Suspense } from "react";
import { Banknote, CreditCard, MapPin } from "lucide-react";

import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { HostLink } from "@/components/host-link";
import { SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listFiatAssessments,
  type FiatAssessment,
} from "@/lib/antifraud/fiat-deposits-api";
import {
  listPaidFiatDeposits,
  type FiatDepositOverviewItem,
} from "@/lib/antifraud/fiat-deposits-overview";
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
  const [result, assessments] = await Promise.all([
    listPaidFiatDeposits({ page, limit: perPage }),
    listFiatAssessments({ page, limit: perPage }),
  ]);
  const assessmentsById = new Map(
    assessments.data.map((assessment) => [assessment.deposit_intent_id, assessment]),
  );

  return (
    <>
      {result.data.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-14 text-center text-sm text-muted-foreground">
          No Fiat deposits found.
        </div>
      ) : (
        <div className="space-y-3">
          {result.data.map((deposit) => (
            <DepositCard
              key={deposit.id}
              deposit={deposit}
              assessment={assessmentsById.get(deposit.id)}
            />
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

function DepositCard({
  deposit,
  assessment,
}: {
  deposit: FiatDepositOverviewItem;
  assessment?: FiatAssessment;
}) {
  const customerPaid = deposit.customerPaidUsd ?? deposit.requestedAmountUsd;
  const displayName = deposit.username ?? deposit.accountEmail ?? deposit.userId;
  const verdict = assessment?.verdict === "bad"
    ? "High risk"
    : assessment?.verdict === "review"
      ? "Review"
      : assessment?.verdict === "good"
        ? "Good"
        : "Scoring pending";
  const checkoutEmailDiffers = Boolean(
    deposit.checkoutEmail
      && deposit.signupEmail
      && deposit.checkoutEmail.toLowerCase() !== deposit.signupEmail.toLowerCase(),
  );
  const countryDiffers = Boolean(
    deposit.checkoutCountry
      && deposit.accountCountry
      && deposit.checkoutCountry.toUpperCase() !== deposit.accountCountry.toUpperCase(),
  );

  return (
    <article className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <HostLink
            href={`/users/${deposit.userId}`}
            className="block truncate font-semibold hover:underline"
          >
            {displayName}
          </HostLink>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {deposit.userId}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatRelative(deposit.paidAt)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge variant="outline">{deposit.status.replaceAll("_", " ")}</Badge>
          <Badge
            variant="outline"
            className={cn(
              assessment?.verdict === "bad"
                ? "border-rose-500/30 text-rose-700 dark:text-rose-300"
                : assessment?.verdict === "review"
                  ? "border-amber-500/30 text-amber-700 dark:text-amber-300"
                  : assessment?.verdict === "good"
                    ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                    : "text-muted-foreground",
            )}
          >
            {assessment ? `${verdict} · ${assessment.risk_score}/100` : verdict}
          </Badge>
        </div>
      </div>

      <div className="mt-4 grid auto-rows-fr gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <FactCell
          label="Balance credit"
          value={deposit.creditedAmountUsd == null
            ? "Pending"
            : formatCurrency(deposit.creditedAmountUsd)}
        />
        <FactCell label="Customer paid" value={formatCurrency(customerPaid)} />
        <FactCell
          label="Checkout email"
          value={deposit.checkoutEmail ?? "Unavailable"}
          alert={checkoutEmailDiffers}
        />
        <FactCell label="Signup email" value={deposit.signupEmail ?? "Unavailable"} />
        <FactCell
          label="Checkout location"
          value={deposit.checkoutCountry ?? "Unknown"}
          alert={countryDiffers}
        />
        <FactCell label="Account location" value={deposit.accountCountry ?? "Unknown"} />
        <FactCell
          label="Whop checkout IP"
          value={assessment?.detection_evidence.checkoutIp ?? "Unavailable"}
        />
        <FactCell
          label={deposit.latestAuthEvent === "login"
            ? "Latest login IP"
            : deposit.latestAuthEvent === "register"
              ? "Signup IP"
              : "Latest auth IP"}
          value={deposit.latestAuthIp ?? "Unavailable"}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <MapPin className="size-3.5" />
          Paid {formatRelative(deposit.paidAt)}
        </span>
        <HostLink
          href={`/transactions/card-payments/${deposit.id}`}
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
