import { Suspense } from "react";
import {
  AlertCircle,
  Banknote,
  Check,
  CreditCard,
  Mail,
  MapPin,
  UserRound,
  Wifi,
  X,
} from "lucide-react";

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
  listFiatDeposits,
  type FiatDepositOverviewItem,
} from "@/lib/antifraud/fiat-deposits-overview";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { parsePage, parsePerPage } from "@/lib/utils/pagination";

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
    listFiatDeposits({ page, limit: perPage }),
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
  const displayName = deposit.username ?? deposit.accountEmail ?? deposit.userId;
  const failed = isFailedStatus(deposit.status, deposit.providerPaymentStatus);
  const verdict = assessment?.verdict === "bad"
    ? "High risk"
    : assessment?.verdict === "review"
      ? "Review"
      : assessment?.verdict === "good"
        ? "Good"
        : "Scoring pending";
  const amountLabel = failed
    ? "Attempted"
    : deposit.creditedAmountUsd == null
      ? "Expected credit"
      : "Balance credit";
  const amount = failed || deposit.creditedAmountUsd == null
    ? deposit.requestedAmountUsd
    : deposit.creditedAmountUsd;
  const paymentStatus = deposit.providerPaymentStatus
    && deposit.providerPaymentStatus.toLowerCase() !== deposit.status.toLowerCase()
      ? `${deposit.status} · ${deposit.providerPaymentStatus}`
      : deposit.status;

  return (
    <article className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="grid gap-3 px-3 py-2.5 lg:grid-cols-[minmax(14rem,1fr)_auto_auto] lg:items-center">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground">
            <UserRound className="size-3.5" />
          </div>
          <div className="min-w-0">
            <HostLink
              href={`/users/${deposit.userId}`}
              className="block truncate text-sm font-semibold hover:underline"
            >
              {displayName}
            </HostLink>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
              <span className="truncate font-mono" title={deposit.userId}>
                {deposit.userId}
              </span>
              <span className="shrink-0">{formatRelative(deposit.occurredAt)}</span>
              <HostLink
                href={`/transactions/card-payments/${deposit.id}`}
                className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground hover:underline"
              >
                <CreditCard className="size-3" />
                Details
              </HostLink>
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          <AmountFact
            label={amountLabel}
            value={formatCurrency(amount)}
            accent={!failed}
          />
          {!failed && deposit.customerPaidUsd != null && (
            <AmountFact
              label="Customer paid"
              value={formatCurrency(deposit.customerPaidUsd)}
            />
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 lg:justify-end">
          <Badge
            variant="outline"
            className={cn(
              "h-5 px-1.5 text-[10px]",
              statusClassName(deposit.status, deposit.providerPaymentStatus),
            )}
          >
            {paymentStatus.replaceAll("_", " ")}
          </Badge>
          {assessment && (
            <Badge
              variant="outline"
              className={cn(
                "h-5 px-1.5 text-[10px]",
                assessment.verdict === "bad"
                  ? "border-rose-500/30 text-rose-700 dark:text-rose-300"
                  : assessment.verdict === "review"
                    ? "border-amber-500/30 text-amber-700 dark:text-amber-300"
                    : "border-emerald-500/30 text-emerald-700 dark:text-emerald-300",
              )}
            >
              {verdict} · {assessment.risk_score}/100
            </Badge>
          )}
        </div>
      </div>

      <div className="grid gap-2 border-t bg-muted/10 px-3 py-2 sm:grid-cols-2 xl:grid-cols-3">
        <ComparisonFact
          icon={Mail}
          label="Email"
          checkoutLabel="Checkout"
          checkoutValue={deposit.checkoutEmail ?? "Unavailable"}
          accountLabel="Signup"
          accountValue={deposit.signupEmail ?? "Unavailable"}
        />
        <ComparisonFact
          icon={MapPin}
          label="Location"
          checkoutLabel="Checkout"
          checkoutValue={deposit.checkoutCountry ?? "Unknown"}
          accountLabel="Account"
          accountValue={deposit.accountCountry ?? "Unknown"}
        />
        <ComparisonFact
          icon={Wifi}
          label="IP address"
          checkoutLabel="Whop checkout"
          checkoutValue={assessment?.detection_evidence.checkoutIp ?? "Unavailable"}
          accountLabel={deposit.latestAuthEvent === "login"
            ? "Latest login IP"
            : deposit.latestAuthEvent === "register"
              ? "Signup IP"
              : "Latest auth IP"}
          accountValue={deposit.latestAuthIp ?? "Unavailable"}
          mono
        />
      </div>

      {deposit.failureReason && (
        <div className="flex items-start gap-1.5 border-t border-red-500/20 px-3 py-2 text-[11px] text-red-600 dark:text-red-400">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          <span className="line-clamp-2">{deposit.failureReason}</span>
        </div>
      )}
    </article>
  );
}

function isFailedStatus(status: string, providerStatus: string | null): boolean {
  return [status, providerStatus ?? ""].some((value) =>
    /failed|declined|denied|canceled|cancelled/i.test(value),
  );
}

function statusClassName(status: string, providerStatus: string | null): string {
  if (isFailedStatus(status, providerStatus) || status === "disputed") {
    return "border-red-500/30 text-red-600 dark:text-red-400";
  }
  if (["completed", "partially_refunded", "refunded"].includes(status)) {
    return "border-emerald-500/30 text-emerald-600 dark:text-emerald-400";
  }
  return "border-amber-500/30 text-amber-700 dark:text-amber-300";
}

function AmountFact({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex h-10 min-w-28 flex-col justify-center rounded-lg border bg-background px-2.5 text-right">
      <p className="text-[9px] font-medium uppercase leading-none tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={cn(
        "mt-1 whitespace-nowrap text-sm font-semibold leading-none tabular-nums",
        accent && "text-emerald-600 dark:text-emerald-400",
      )}>
        {value}
      </p>
    </div>
  );
}

const UNAVAILABLE_VALUES = new Set(["unknown", "unavailable"]);

function ComparisonFact({
  icon: Icon,
  label,
  checkoutLabel,
  checkoutValue,
  accountLabel,
  accountValue,
  mono = false,
}: {
  icon: typeof Mail;
  label: string;
  checkoutLabel: string;
  checkoutValue: string;
  accountLabel: string;
  accountValue: string;
  mono?: boolean;
}) {
  const checkout = checkoutValue.trim().toLowerCase();
  const account = accountValue.trim().toLowerCase();
  const comparable = checkout.length > 0
    && account.length > 0
    && !UNAVAILABLE_VALUES.has(checkout)
    && !UNAVAILABLE_VALUES.has(account);
  const matches = comparable ? checkout === account : null;

  return (
    <dl className="relative min-w-0 rounded-lg border bg-background px-2.5 py-2">
      {matches === true && (
        <Check
          className="absolute right-2 top-2 size-3.5 text-emerald-600 dark:text-emerald-400"
          aria-label={`${label} matches`}
        />
      )}
      {matches === false && (
        <X
          className="absolute right-2 top-2 size-3.5 text-red-600 dark:text-red-400"
          aria-label={`${label} does not match`}
        />
      )}
      <dt className="flex items-center gap-1.5 text-[10px] font-semibold">
        <Icon className="size-3 shrink-0" />
        {label}
      </dt>
      <dd className="mt-1 grid min-w-0 grid-cols-2 gap-2">
        {[
          [checkoutLabel, checkoutValue],
          [accountLabel, accountValue],
        ].map(([itemLabel, value], index) => (
          <div key={itemLabel} className="min-w-0">
            <p className="truncate text-[8px] uppercase tracking-wide text-muted-foreground">
              {itemLabel}
            </p>
            <p
              className={cn(
                "mt-0.5 truncate text-[11px] font-medium",
                mono && "font-mono text-[10px]",
                matches === false && index === 0 && "text-red-600 dark:text-red-400",
              )}
              title={value}
            >
              {value}
            </p>
          </div>
        ))}
      </dd>
    </dl>
  );
}

function DepositsSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, index) => (
        <Skeleton key={index} className="h-36 w-full rounded-xl" />
      ))}
    </div>
  );
}
