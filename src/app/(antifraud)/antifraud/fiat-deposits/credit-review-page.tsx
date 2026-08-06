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
import {
  getFiatCreditReviewStates,
  type FiatCreditReviewState,
} from "@/lib/antifraud/fiat-credit-review";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  getFiatDepositReviewUsers,
  type FiatDepositReviewUser,
} from "@/lib/queries/fiat-deposit-review-users";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { RequireKycAction } from "./require-kyc-action";
import { FiatDepositReviewDecision } from "./review-decision";

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

/** Wall-clock bound on every read this queue makes, matching the other
 *  antifraud routes. The monitor client has its own 12s fetch timeout, but a
 *  hung socket / slow admin-DB read must not be able to hold the segment. */
const QUERY_TIMEOUT_MS = 10_000;

/** Monitor page size. Its API caps `limit` at 100, so this is the largest
 *  number of review rows a single upstream hop can return. */
const UPSTREAM_PAGE_SIZE = 100;

/**
 * Hard ceiling on how many upstream pages this page will pull.
 *
 * The queue is filtered against the ADMIN DB (`admin_fiat_credit_reviews`)
 * AFTER the monitor returns it, because the monitor has no knowledge of which
 * deposits staff already decided — so the visible list cannot be produced by
 * asking the monitor for one page. The old code answered that by walking
 * EVERY upstream page (unbounded: the monitor keeps declined intents in
 * `status='review'` forever, so that list only ever grows).
 *
 * This bounds the walk at 5 × 100 = 500 review rows, fetched as ONE parallel
 * wave, and reports the shortfall LOUDLY when the upstream queue is bigger.
 * A money queue must never quietly hide rows.
 */
const MAX_UPSTREAM_PAGES = 5;

type QueueScan = {
  assessments: FiatAssessment[];
  /** Upstream review rows outside the scan window (0 in the normal case). */
  notScanned: number;
};

const EMPTY_SCAN: QueueScan = { assessments: [], notScanned: 0 };

/**
 * Bounded read of the active review queue.
 *
 * Throws on ANY upstream failure so `safeQuery` can turn it into the loud
 * degraded banner — an empty queue rendered as if it were real would read as
 * "nothing to decide", which is the one wrong answer this page must not give.
 */
async function scanActiveAssessments(): Promise<QueueScan> {
  const first = await listFiatAssessments({
    page: 1,
    limit: UPSTREAM_PAGE_SIZE,
    status: "review",
  });
  if (first.error) {
    throw new Error("The Antifraud monitor did not return the review queue.");
  }

  const assessments = [...first.data];
  const pageCount = Math.max(first.pagination?.pages ?? 1, 1);
  const scanPages = Math.min(pageCount, MAX_UPSTREAM_PAGES);
  if (scanPages > 1) {
    // ONE parallel wave (≤ 4 calls), not the old serial batches.
    const rest = await Promise.all(
      Array.from({ length: scanPages - 1 }, (_, index) =>
        listFiatAssessments({
          page: index + 2,
          limit: UPSTREAM_PAGE_SIZE,
          status: "review",
        }),
      ),
    );
    if (rest.some((result) => result.error)) {
      throw new Error("The Antifraud monitor did not return the review queue.");
    }
    assessments.push(...rest.flatMap((result) => result.data));
  }

  const upstreamTotal = first.pagination?.total ?? assessments.length;
  return {
    assessments,
    notScanned: Math.max(0, upstreamTotal - assessments.length),
  };
}

export async function FiatDepositReviewQueue({
  page,
  perPage,
  canManageKyc,
}: {
  page: number;
  perPage: number;
  canManageKyc: boolean;
}) {
  const offset = (page - 1) * perPage;

  const scanResult = await safeQuery(
    () => scanActiveAssessments(),
    EMPTY_SCAN,
    "antifraud.fiat-review-queue",
    QUERY_TIMEOUT_MS,
  );
  const { assessments, notScanned } = scanResult.data;

  // Genuinely dependent: the decision states are keyed on the intent ids the
  // scan just returned, and the player lookup is keyed on the user ids of the
  // rows that survive the filter. Both stay bounded by the scan window.
  const stateResult = await safeQuery(
    () =>
      getFiatCreditReviewStates(
        assessments.map((item) => item.deposit_intent_id),
      ),
    new Map<string, FiatCreditReviewState>(),
    "antifraud.fiat-review-states",
    QUERY_TIMEOUT_MS,
  );

  const queueFailed = scanResult.error !== null || stateResult.error !== null;
  const states = stateResult.data;
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
  const usersResult = await safeQuery(
    () => getFiatDepositReviewUsers(queue.items.map((item) => item.user_id)),
    new Map<string, FiatDepositReviewUser>(),
    "antifraud.fiat-review-users",
    QUERY_TIMEOUT_MS,
  );
  const users = usersResult.data;
  const totalPages = Math.ceil(queue.total / perPage);

  return (
    <>
      {scanResult.error !== null && (
        <DegradedNotice
          title="The Fiat review queue could not be loaded"
          detail={
            scanResult.kind === "timeout"
              ? "The monitor read timed out. This queue is EMPTY because of that failure, not because there is nothing to decide — refresh before concluding anything."
              : "The monitor read failed. This queue is EMPTY because of that failure, not because there is nothing to decide."
          }
        />
      )}
      {stateResult.error !== null && (
        <DegradedNotice
          title="Existing decisions could not be checked"
          detail={
            stateResult.kind === "timeout"
              ? "The admin-side decision read timed out, so already-decided deposits cannot be filtered out. The queue is EMPTY rather than showing deposits somebody may already have actioned — refresh to retry."
              : "The admin-side decision read failed, so already-decided deposits cannot be filtered out. The queue is EMPTY rather than showing deposits somebody may already have actioned."
          }
        />
      )}
      {!queueFailed && notScanned > 0 && (
        <DegradedNotice
          title="The review queue is larger than one scan window"
          detail={`Only the ${assessments.length} most recent deposits in the monitor's review state were checked; up to ${notScanned} older ones are NOT listed below. Decide the visible queue down first, then refresh.`}
        />
      )}
      {usersResult.error !== null && (
        <DegradedNotice
          title="Player details could not be loaded"
          detail="Every review below is real and complete, but the player name and country are missing — rows fall back to the raw user id."
        />
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
                    <div className="flex flex-wrap gap-2">
                      <FiatDepositReviewDecision
                        intentId={item.id}
                        displayName={displayName}
                        amount={money(item.credited_amount_cents)}
                      />
                      {canManageKyc && (
                        <RequireKycAction
                          userId={item.user_id}
                          displayName={displayName}
                        />
                      )}
                    </div>
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
                        <div className="flex flex-wrap gap-2">
                          <FiatDepositReviewDecision
                            intentId={item.id}
                            displayName={displayName}
                            amount={money(item.credited_amount_cents)}
                          />
                          {canManageKyc && (
                            <RequireKycAction
                              userId={item.user_id}
                              displayName={displayName}
                            />
                          )}
                        </div>
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
    </>
  );
}

/**
 * Loud degradation for a money surface — same contract as `/antifraud/refunds`.
 * A failed read is stated outright instead of being smoothed into an empty
 * state, because "no deposits need review" and "we could not find out" must
 * never look the same on this page.
 */
function DegradedNotice({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div
      role="status"
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3"
    >
      <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
        {title}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
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
