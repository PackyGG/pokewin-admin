import {
  AlertTriangle,
  Banknote,
  Clock3,
  CreditCard,
  ExternalLink,
  Fingerprint,
  Mail,
  MapPin,
  ShieldCheck,
  UserRound,
  Wifi,
} from "lucide-react";

import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { EmptyState } from "@/components/empty-state";
import { HostLink } from "@/components/host-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { FiatReviewEvidence } from "./review-evidence";

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
  assessment: FiatAssessment;
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
    assessment: item,
  };
}

/** Wall-clock bound on the ADMIN-DB reads this queue makes. */
const QUERY_TIMEOUT_MS = 10_000;

/**
 * Budget for the FIRST upstream page — deliberately larger than the monitor
 * client's own 12s fetch timeout (`fiat-deposits-api.ts`).
 *
 * A 10s outer budget over a 12s inner one is strictly wrong: it guarantees the
 * outer timer fires on a request that was still legitimately in flight, so the
 * queue renders empty for a monitor that was about to answer. The outer bound
 * exists to stop a hung socket holding the segment, so it must sit ABOVE the
 * inner one, not below it.
 */
const FIRST_PAGE_TIMEOUT_MS = 14_000;

/**
 * Budget for the follow-up pages. Smaller on purpose: page 1 is already on
 * screen by the time these matter, so a slow tail degrades to "scan
 * incomplete" instead of making the operator wait.
 */
const REST_PAGES_TIMEOUT_MS = 8_000;

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
 * EVERY upstream page (unbounded: the monitor keeps declined intents with
 * `verdict='review'` forever, so that list only ever grows).
 *
 * This bounds the walk at 5 × 100 = 500 review rows, fetched serially to avoid
 * multiplying monitor refresh work, and reports the shortfall LOUDLY when the
 * upstream queue is bigger.
 * A money queue must never quietly hide rows.
 */
const MAX_UPSTREAM_PAGES = 5;

/**
 * Bounded read of the active review queue.
 *
 * Throws on ANY upstream failure so `safeQuery` can turn it into the loud
 * degraded banner — an empty queue rendered as if it were real would read as
 * "nothing to decide", which is the one wrong answer this page must not give.
 */
async function scanFirstPage(): Promise<{
  assessments: FiatAssessment[];
  pageCount: number;
  upstreamTotal: number;
}> {
  const first = await listFiatAssessments({
    page: 1,
    limit: UPSTREAM_PAGE_SIZE,
    status: "review",
  });
  if (first.error) {
    throw new Error("The Antifraud monitor did not return the review queue.");
  }
  return {
    assessments: [...first.data],
    pageCount: Math.max(first.pagination?.pages ?? 1, 1),
    upstreamTotal: first.pagination?.total ?? first.data.length,
  };
}

/**
 * Pages 2..N, fetched one at a time.
 *
 * Deliberately SERIAL. Every `GET /v1/fiat-deposits` makes the monitor re-run
 * `refresh({limit: 100})` — a full re-scoring pass including provider
 * enrichment. Firing the extra pages as a parallel wave multiplies that work
 * by the number of pages and is what pushed the whole scan past its budget.
 * Serial keeps the monitor's load identical to one page at a time, and the
 * caller's timeout bounds the total either way.
 */
async function scanRestPages(pageCount: number): Promise<FiatAssessment[]> {
  const scanPages = Math.min(pageCount, MAX_UPSTREAM_PAGES);
  const assessments: FiatAssessment[] = [];
  for (let page = 2; page <= scanPages; page += 1) {
    const result = await listFiatAssessments({
      page,
      limit: UPSTREAM_PAGE_SIZE,
      status: "review",
    });
    // Keep what we already have. A partial scan is reported as a shortfall by
    // the caller; it must never discard page 1.
    if (result.error) break;
    assessments.push(...result.data);
  }
  return assessments;
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

  // Page 1 decides whether this queue is usable at all. It gets its own budget,
  // above the monitor client's 12s fetch timeout.
  const firstResult = await safeQuery(
    () => scanFirstPage(),
    null,
    "antifraud.fiat-review-queue",
    FIRST_PAGE_TIMEOUT_MS,
  );

  // The tail is best-effort: if it is slow or fails, the operator still gets
  // page 1 plus an honest count of what was not scanned.
  const firstPage = firstResult.data;
  const restResult = firstPage && firstPage.pageCount > 1
    ? await safeQuery(
        () => scanRestPages(firstPage.pageCount),
        [] as FiatAssessment[],
        "antifraud.fiat-review-queue-tail",
        REST_PAGES_TIMEOUT_MS,
      )
    : { data: [] as FiatAssessment[], error: null };

  const assessments: FiatAssessment[] = firstPage
    ? [...firstPage.assessments, ...restResult.data]
    : [];
  const notScanned = firstPage
    ? Math.max(0, firstPage.upstreamTotal - assessments.length)
    : 0;
  const scanResult = firstResult;

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
        <div className="space-y-4">
          {queue.items.length === 0 ? (
            <div className="overflow-hidden rounded-2xl border bg-card">
              <QueueEmpty failed={queueFailed} />
            </div>
          ) : (
            queue.items.map((item) => (
              <ReviewDepositCard
                key={item.id}
                item={item}
                user={users.get(item.user_id)}
                canManageKyc={canManageKyc}
              />
            ))
          )}
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

function ReviewDepositCard({
  item,
  user,
  canManageKyc,
}: {
  item: ReviewItem;
  user: FiatDepositReviewUser | undefined;
  canManageKyc: boolean;
}) {
  const displayName = user?.username ?? user?.email ?? item.user_id;
  const receivedAt = item.review_requested_at ?? item.paid_at ?? item.created_at;

  return (
    <article className="overflow-hidden rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md">
      <header className="grid gap-3 border-b bg-muted/20 px-4 py-3 xl:grid-cols-[minmax(15rem,1fr)_minmax(17rem,auto)_auto] xl:items-start">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground">
            <UserRound className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <HostLink
                href={`/users/${item.user_id}`}
                className="truncate text-base font-semibold tracking-tight hover:underline"
              >
                {displayName}
              </HostLink>
              {user?.countryCode && (
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-medium">
                  {user.countryCode}
                </Badge>
              )}
              {statusBadge()}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span className="max-w-64 truncate font-mono" title={item.user_id}>
                {item.user_id}
              </span>
              <span className="flex items-center gap-1">
                <Clock3 className="size-3.5" />
                {formatRelative(receivedAt)}
              </span>
            </div>
          </div>
        </div>

        <div className="flex min-w-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-12 w-12 px-0 sm:w-24 sm:px-3"
            title={`Open ${displayName}'s profile in a new tab`}
            render={
              <HostLink
                href={`/users/${item.user_id}`}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <UserRound className="size-4" />
            <span className="hidden sm:inline">Profile</span>
          </Button>
          <div className="min-w-40 flex-1">
            <AmountFact
              label="Balance credit"
              value={money(item.credited_amount_cents)}
              accent
            />
          </div>
        </div>

        <div className="flex min-h-12 flex-wrap items-center gap-2 xl:justify-end">
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
      </header>

      <div className="grid xl:grid-cols-[minmax(0,0.9fr)_minmax(32rem,1.1fr)]">
        <section className="min-w-0 p-4 xl:border-r">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Decision evidence
          </p>
          <FiatReviewEvidence
            assessment={item.assessment}
            safeguards={user ? {
              fiatDepositsLocked: user.fiatDepositsLocked,
              withdrawalsLocked: user.withdrawalsLocked,
            } : undefined}
          />
        </section>

        <aside className="border-t p-4 xl:border-t-0">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Checkout compared with account
          </p>
          <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
            <ComparisonFact
              icon={MapPin}
              label="Location"
              checkoutLabel="Whop checkout"
              checkoutValue={item.assessment.provider_evidence.billingCountry ?? "Unknown"}
              accountLabel="Account"
              accountValue={user?.countryCode ?? "Unknown"}
            />
            <ComparisonFact
              icon={Wifi}
              label="IP address"
              checkoutLabel="Whop checkout"
              checkoutValue={item.assessment.detection_evidence.checkoutIp ?? "Unavailable"}
              accountLabel={user?.latestAuthEvent === "login"
                ? "Latest login"
                : user?.latestAuthEvent === "register"
                  ? "Signup"
                  : "Latest auth"}
              accountValue={user?.latestAuthIp ?? "Unavailable"}
              mono
            />
            <ComparisonFact
              icon={Mail}
              label="Email"
              checkoutLabel="Checkout"
              checkoutValue={item.assessment.provider_evidence.checkoutEmail ?? "Unavailable"}
              accountLabel="Signup"
              accountValue={user?.signupEmail ?? "Unavailable"}
            />
            <ComparisonFact
              icon={Fingerprint}
              label="Fingerprint"
              checkoutLabel="Checkout FP check"
              checkoutValue={item.assessment.detection_evidence.checkoutFingerprint ?? "Unavailable"}
              accountLabel={user?.latestFingerprintEvent
                ? `Latest ${user.latestFingerprintEvent}`
                : "Latest system"}
              accountValue={user?.latestFingerprint ?? "Unavailable"}
              mono
            />
          </dl>
          <ReviewLinks item={item} />
          {item.failure_reason && (
            <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
              {item.failure_reason}
            </div>
          )}
        </aside>
      </div>
    </article>
  );
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
    <div className="flex h-12 min-w-0 flex-col justify-center rounded-lg border bg-background px-3 py-1.5 text-right">
      <p className="text-[10px] font-medium leading-none uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={accent
        ? "mt-1 whitespace-nowrap text-base font-bold leading-none tabular-nums text-emerald-600 dark:text-emerald-400"
        : "mt-1 whitespace-nowrap text-base font-semibold leading-none tabular-nums"}
      >
        {value}
      </p>
    </div>
  );
}

function ComparisonFact({
  icon: Icon,
  label,
  checkoutLabel,
  checkoutValue,
  accountLabel,
  accountValue,
  mono = false,
}: {
  icon: typeof Banknote;
  label: string;
  checkoutLabel: string;
  checkoutValue: string;
  accountLabel: string;
  accountValue: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/10 p-2.5">
      <dt className="flex items-center gap-1.5 text-[11px] font-semibold">
        <Icon className="size-3.5 shrink-0" />
        {label}
      </dt>
      <dd className="mt-1.5 grid min-w-0 grid-cols-2 gap-2">
        {[
          [checkoutLabel, checkoutValue],
          [accountLabel, accountValue],
        ].map(([itemLabel, value]) => (
          <div key={itemLabel} className="min-w-0">
            <p className="truncate text-[9px] uppercase tracking-wide text-muted-foreground" title={itemLabel}>
              {itemLabel}
            </p>
            <p
              className={`mt-0.5 truncate text-xs font-medium ${mono ? "font-mono text-[11px]" : ""}`}
              title={value}
            >
              {value}
            </p>
          </div>
        ))}
      </dd>
    </div>
  );
}

function ReviewLinks({ item }: { item: ReviewItem }) {
  const paymentReference = item.provider_payment_id ?? item.provider_checkout_id ?? item.id;

  return (
    <div className="mt-2 flex min-w-0 items-center gap-3 rounded-lg border bg-muted/10 px-3 py-2 text-xs">
      <HostLink
        href={`/transactions/card-payments/${item.id}`}
        className="flex shrink-0 items-center gap-2 font-medium hover:underline"
      >
        <CreditCard className="size-3.5 text-muted-foreground" />
        Payment details
        <ExternalLink className="size-3.5 text-muted-foreground" />
      </HostLink>
      <p
        className="min-w-0 flex-1 truncate border-l pl-3 font-mono text-[10px] text-muted-foreground"
        title={paymentReference}
      >
        {paymentReference}
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
