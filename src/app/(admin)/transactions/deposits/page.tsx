import Link from "next/link";
import {
  AlertTriangle,
  BadgeDollarSign,
  ExternalLink,
  ShieldCheck,
} from "lucide-react";

import { GlobalFiatReviewCard } from "@/app/(antifraud)/antifraud/config/fiat-auto-approval-card";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { EmptyState } from "@/components/empty-state";
import { PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { canManageAntifraud } from "@/lib/antifraud/access";
import {
  FiatDepositReviewStatusSchema,
  getFiatDepositAutomaticCreditConfig,
  getFiatDepositReviewQueue,
  type FiatDepositReviewItem,
  type FiatDepositReviewStatus,
} from "@/lib/backend-api/fiat-deposit-review";
import { requirePageAccess } from "@/lib/dal";
import { getFiatDepositReviewUsers } from "@/lib/queries/fiat-deposit-review-users";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { parsePage, parsePerPage } from "@/lib/utils/pagination";
import { cn } from "@/lib/utils";
import { FiatDepositReviewDecision } from "./review-decision";

export const metadata = { title: "Fiat Deposit Reviews" };

const QUEUE_STATUSES = [
  "review",
  "approval_processing",
  "refund_pending",
  "refund_failed",
] as const satisfies readonly FiatDepositReviewStatus[];

const STATUS_LABELS: Record<(typeof QUEUE_STATUSES)[number], string> = {
  review: "Needs review",
  approval_processing: "Approving",
  refund_pending: "Refund pending",
  refund_failed: "Refund failed",
};

const STATUS_CLASSES: Record<(typeof QUEUE_STATUSES)[number], string> = {
  review:
    "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  approval_processing:
    "border-blue-500/30 bg-blue-500/15 text-blue-700 dark:text-blue-300",
  refund_pending:
    "border-violet-500/30 bg-violet-500/15 text-violet-700 dark:text-violet-300",
  refund_failed:
    "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300",
};

type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function queueStatus(value: string | undefined): FiatDepositReviewStatus | undefined {
  const parsed = FiatDepositReviewStatusSchema.safeParse(value);
  return parsed.success && QUEUE_STATUSES.includes(
    parsed.data as (typeof QUEUE_STATUSES)[number],
  )
    ? parsed.data
    : undefined;
}

function filterHref(
  status: FiatDepositReviewStatus | undefined,
  perPage: number,
): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (perPage !== 20) params.set("perPage", String(perPage));
  const query = params.toString();
  return query ? `/transactions/deposits?${query}` : "/transactions/deposits";
}

function money(cents: number): string {
  return formatCurrency(cents / 100);
}

function statusBadge(status: FiatDepositReviewStatus) {
  if (!QUEUE_STATUSES.includes(status as (typeof QUEUE_STATUSES)[number])) {
    return <Badge variant="outline">{status.replaceAll("_", " ")}</Badge>;
  }
  const queueStatus = status as (typeof QUEUE_STATUSES)[number];
  return (
    <Badge variant="outline" className={STATUS_CLASSES[queueStatus]}>
      {STATUS_LABELS[queueStatus]}
    </Badge>
  );
}

export default async function FiatDepositReviewsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requirePageAccess("/transactions/deposits");
  const raw = await searchParams;
  const page = parsePage(firstValue(raw.page));
  const perPage = Math.min(parsePerPage(firstValue(raw.perPage)), 100);
  const status = queueStatus(firstValue(raw.status));
  const offset = (page - 1) * perPage;

  const [queueResult, configResult] = await Promise.allSettled([
    getFiatDepositReviewQueue({ status, limit: perPage, offset }),
    getFiatDepositAutomaticCreditConfig(),
  ]);
  const queue =
    queueResult.status === "fulfilled"
      ? queueResult.value
      : { items: [], total: 0, limit: perPage, offset };
  const users = await getFiatDepositReviewUsers(
    queue.items.map((item) => item.user_id),
  ).catch(() => new Map());
  const totalPages = Math.ceil(queue.total / perPage);
  const canDecide = canManageAntifraud(session);
  const automaticCredit =
    configResult.status === "fulfilled"
      ? configResult.value.fiat_deposit_automatic_credit_enabled
      : null;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <div className="space-y-1">
        <SectionHeading icon={BadgeDollarSign} title="Fiat Deposit Reviews" />
        <p className="text-sm text-muted-foreground">
          Review authorized Whop payments before player balances are credited.
          Crypto deposits are not included.
        </p>
      </div>

      {canDecide ? (
        <GlobalFiatReviewCard initialEnabled={automaticCredit} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Fiat credit policy</CardTitle>
            <CardDescription>
              You can inspect this queue. Only owners and admins can approve,
              reject, or change the global credit policy.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Badge variant="outline">
              {automaticCredit === null
                ? "Policy unavailable"
                : automaticCredit
                  ? "Automatic credit"
                  : "Admin approval required"}
            </Badge>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeading icon={ShieldCheck} title="Credit review queue" />
          <span className="text-xs text-muted-foreground">
            {queue.total} payment{queue.total === 1 ? "" : "s"}
          </span>
        </div>

        <div className="flex flex-wrap gap-2" aria-label="Review status filters">
          <FilterLink
            active={!status}
            href={filterHref(undefined, perPage)}
            label="All active"
          />
          {QUEUE_STATUSES.map((itemStatus) => (
            <FilterLink
              key={itemStatus}
              active={status === itemStatus}
              href={filterHref(itemStatus, perPage)}
              label={STATUS_LABELS[itemStatus]}
            />
          ))}
        </div>

        {queueResult.status === "rejected" && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            The backend review queue could not be loaded. No deposit decisions
            are available until the authoritative service responds.
          </div>
        )}

        <div className="space-y-3 lg:hidden">
          {queue.items.length === 0 ? (
            <QueueEmpty failed={queueResult.status === "rejected"} />
          ) : (
            queue.items.map((item) => {
              const user = users.get(item.user_id);
              const displayName = user?.username ?? user?.email ?? item.user_id;
              return (
                <Card key={item.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="truncate text-sm">
                          <Link href={`/users/${item.user_id}`} className="hover:underline">
                            {displayName}
                          </Link>
                        </CardTitle>
                        <CardDescription className="truncate font-mono text-[10px]">
                          {item.id}
                        </CardDescription>
                      </div>
                      {statusBadge(item.status)}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <ReviewFacts item={item} countryCode={user?.countryCode ?? null} />
                    <ReviewLinks item={item} />
                    {canDecide && (
                      <FiatDepositReviewDecision
                        intentId={item.id}
                        displayName={displayName}
                        amount={money(item.credited_amount_cents)}
                        status={item.status}
                      />
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>

        <div className="hidden overflow-x-auto rounded-md border lg:block">
          <Table zebra>
            <TableHeader>
              <TableRow>
                <TableHead>Player</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Received</TableHead>
                <TableHead className="min-w-64">Decision</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queue.items.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="p-0">
                    <QueueEmpty failed={queueResult.status === "rejected"} />
                  </TableCell>
                </TableRow>
              ) : (
                queue.items.map((item) => {
                  const user = users.get(item.user_id);
                  const displayName = user?.username ?? user?.email ?? item.user_id;
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="min-w-40">
                          <Link
                            href={`/users/${item.user_id}`}
                            className="font-medium hover:underline"
                          >
                            {displayName}
                          </Link>
                          <p className="max-w-48 truncate font-mono text-[10px] text-muted-foreground">
                            {item.user_id}
                          </p>
                          {user?.countryCode && (
                            <p className="text-[10px] text-muted-foreground">
                              {user.countryCode}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <ReviewLinks item={item} />
                      </TableCell>
                      <TableCell>
                        <p className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                          {money(item.credited_amount_cents)}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          Paid {money(item.actual_customer_total_cents ?? item.requested_amount_cents)}
                        </p>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          {statusBadge(item.status)}
                          {item.failure_reason && (
                            <p className="max-w-52 text-[10px] text-red-600 dark:text-red-400">
                              {item.failure_reason}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelative(item.review_requested_at ?? item.paid_at ?? item.created_at)}
                      </TableCell>
                      <TableCell>
                        {canDecide ? (
                          <FiatDepositReviewDecision
                            intentId={item.id}
                            displayName={displayName}
                            amount={money(item.credited_amount_cents)}
                            status={item.status}
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Read only
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        <DataTablePagination
          page={page}
          totalPages={totalPages}
          total={queue.total}
          perPage={perPage}
          degraded={queueResult.status === "rejected"}
        />
      </div>
    </div>
  );
}

function FilterLink({
  active,
  href,
  label,
}: {
  active: boolean;
  href: string;
  label: string;
}) {
  return (
    <Link
      href={href}
      replace
      scroll={false}
      className={cn(
        "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-foreground/20 bg-foreground text-background"
          : "bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
}

function ReviewFacts({
  item,
  countryCode,
}: {
  item: FiatDepositReviewItem;
  countryCode: string | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 text-xs">
      <div>
        <p className="text-muted-foreground">Balance credit</p>
        <p className="font-medium tabular-nums">{money(item.credited_amount_cents)}</p>
      </div>
      <div>
        <p className="text-muted-foreground">Customer paid</p>
        <p className="font-medium tabular-nums">
          {money(item.actual_customer_total_cents ?? item.requested_amount_cents)}
        </p>
      </div>
      <div>
        <p className="text-muted-foreground">Received</p>
        <p>{formatRelative(item.review_requested_at ?? item.paid_at ?? item.created_at)}</p>
      </div>
      <div>
        <p className="text-muted-foreground">Country</p>
        <p>{countryCode ?? "Unknown"}</p>
      </div>
      {item.failure_reason && (
        <div className="col-span-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-red-700 dark:text-red-300">
          {item.failure_reason}
        </div>
      )}
    </div>
  );
}

function ReviewLinks({ item }: { item: FiatDepositReviewItem }) {
  return (
    <div className="space-y-1 text-xs">
      <Link
        href={`/transactions/card-payments/${item.id}`}
        className="flex items-center gap-1 font-medium hover:underline"
      >
        Payment details <ExternalLink className="size-3" />
      </Link>
      <Link
        href={`/antifraud/fiat-deposits?review=${encodeURIComponent(item.id)}`}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
      >
        Risk evidence <ExternalLink className="size-3" />
      </Link>
      <p
        className="max-w-48 truncate font-mono text-[10px] text-muted-foreground"
        title={item.provider_payment_id ?? item.provider_checkout_id ?? item.id}
      >
        {item.provider_payment_id ?? item.provider_checkout_id ?? item.id}
      </p>
    </div>
  );
}

function QueueEmpty({ failed }: { failed: boolean }) {
  return (
    <EmptyState
      icon={failed ? AlertTriangle : ShieldCheck}
      title={failed ? "Review queue unavailable" : "No Fiat credits need review"}
      description={
        failed
          ? "The backend did not return an authoritative queue. Refresh to retry."
          : "There are no authorized Fiat deposits in the selected review state."
      }
      compact
    />
  );
}
