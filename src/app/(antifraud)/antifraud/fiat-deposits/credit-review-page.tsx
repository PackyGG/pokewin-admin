import {
  AlertTriangle,
  ExternalLink,
  ShieldCheck,
} from "lucide-react";

import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { EmptyState } from "@/components/empty-state";
import { HostLink } from "@/components/host-link";
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
import {
  listFiatAssessments,
  type FiatAssessment,
} from "@/lib/antifraud/fiat-deposits-api";
import { getFiatCreditReviewStates } from "@/lib/antifraud/fiat-credit-review";
import { getFiatDepositReviewUsers } from "@/lib/queries/fiat-deposit-review-users";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { parsePage, parsePerPage } from "@/lib/utils/pagination";
import { FiatDepositReviewDecision } from "./review-decision";

export const metadata = { title: "Fiat Deposit Reviews" };

type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function money(cents: number): string {
  return formatCurrency(cents / 100);
}

function statusBadge() {
  return (
    <Badge variant="outline" className="border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300">
      Needs decision
    </Badge>
  );
}

type ReviewItem = {
  id: string;
  user_id: string;
  status: "review";
  currency: string;
  requested_amount_cents: number;
  credited_amount_cents: number;
  actual_customer_total_cents: number | null;
  provider_checkout_id: string | null;
  provider_payment_id: string | null;
  failure_reason: string | null;
  review_requested_at: string | null;
  paid_at: string | null;
  created_at: string;
};

function toReviewItem(item: FiatAssessment): ReviewItem {
  return {
    id: item.deposit_intent_id,
    user_id: item.user_id,
    status: "review",
    currency: item.currency,
    requested_amount_cents: Math.round(item.requested_amount_usd * 100),
    credited_amount_cents: Math.round(item.credited_amount_usd * 100),
    actual_customer_total_cents:
      item.customer_total_usd == null ? null : Math.round(item.customer_total_usd * 100),
    provider_checkout_id: null,
    provider_payment_id: item.provider_payment_id,
    failure_reason: null,
    review_requested_at: item.occurred_at,
    paid_at: item.occurred_at,
    created_at: item.occurred_at,
  };
}

async function loadAllActiveAssessments(): Promise<{
  assessments: FiatAssessment[];
  failed: boolean;
}> {
  try {
    const first = await listFiatAssessments({ page: 1, limit: 100, status: "review" });
    if (first.error) return { assessments: [], failed: true };

    const assessments = [...first.data];
    const pageCount = Math.max(first.pagination?.pages ?? 1, 1);
    for (let start = 2; start <= pageCount; start += 10) {
      const batch = await Promise.all(
        Array.from(
          { length: Math.min(10, pageCount - start + 1) },
          (_, index) =>
            listFiatAssessments({
              page: start + index,
              limit: 100,
              status: "review",
            }),
        ),
      );
      if (batch.some((result) => result.error)) {
        return { assessments: [], failed: true };
      }
      assessments.push(...batch.flatMap((result) => result.data));
    }
    return { assessments, failed: false };
  } catch {
    return { assessments: [], failed: true };
  }
}

export default async function FiatDepositReviewsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAntifraudPageAccess();
  const raw = await searchParams;
  const page = parsePage(firstValue(raw.page));
  const perPage = Math.min(parsePerPage(firstValue(raw.perPage)), 100);
  const offset = (page - 1) * perPage;

  const { assessments, failed: sourceFailed } = await loadAllActiveAssessments();
  const stateResult = await getFiatCreditReviewStates(
    assessments.map((item) => item.deposit_intent_id),
  ).then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const, value: new Map() }),
  );
  const queueFailed = sourceFailed || !stateResult.ok;
  const states = stateResult.value;
  const activeItems = assessments
    .filter((item) => {
      const state = states.get(item.deposit_intent_id);
      return !state || state === "approval_failed" || state === "containment_failed";
    })
    .map(toReviewItem);
  const queue = {
    items: queueFailed ? [] : activeItems.slice(offset, offset + perPage),
    total: queueFailed ? 0 : activeItems.length,
  };
  const users = await getFiatDepositReviewUsers(
    queue.items.map((item) => item.user_id),
  ).catch(() => new Map());
  const totalPages = Math.ceil(queue.total / perPage);

  return (
    <div className="space-y-3">
        <div className="flex justify-end">
          <span className="text-xs text-muted-foreground">
            {queue.total} payment{queue.total === 1 ? "" : "s"}
          </span>
        </div>

        {queueFailed && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            The Antifraud review queue could not be loaded safely. No deposit
            decisions are available until both decision stores respond.
          </div>
        )}

        <div className="space-y-3 lg:hidden">
          {queue.items.length === 0 ? (
            <QueueEmpty failed={queueFailed} />
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
                          <HostLink href={`/users/${item.user_id}`} className="hover:underline">
                            {displayName}
                          </HostLink>
                        </CardTitle>
                        <CardDescription className="truncate font-mono text-[10px]">
                          {item.id}
                        </CardDescription>
                      </div>
                      {statusBadge()}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <ReviewFacts item={item} countryCode={user?.countryCode ?? null} />
                    <ReviewLinks item={item} />
                    <FiatDepositReviewDecision
                      intentId={item.id}
                      displayName={displayName}
                      amount={money(item.credited_amount_cents)}
                    />
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
                    <QueueEmpty failed={queueFailed} />
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
                          <HostLink
                            href={`/users/${item.user_id}`}
                            className="font-medium hover:underline"
                          >
                            {displayName}
                          </HostLink>
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
                          {statusBadge()}
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
                        <FiatDepositReviewDecision
                          intentId={item.id}
                          displayName={displayName}
                          amount={money(item.credited_amount_cents)}
                        />
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
          degraded={queueFailed}
        />
    </div>
  );
}

function ReviewFacts({
  item,
  countryCode,
}: {
  item: ReviewItem;
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

function ReviewLinks({ item }: { item: ReviewItem }) {
  return (
    <div className="space-y-1 text-xs">
      <HostLink
        href={`/transactions/card-payments/${item.id}`}
        className="flex items-center gap-1 font-medium hover:underline"
      >
        Payment details <ExternalLink className="size-3" />
      </HostLink>
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
