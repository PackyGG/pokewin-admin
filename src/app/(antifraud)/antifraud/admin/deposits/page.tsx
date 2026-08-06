import { Suspense } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HostLink } from "@/components/host-link";
import {
  getDeclinedFiatCreditReviews,
  type DeclinedFiatCreditReview,
} from "@/lib/antifraud/fiat-credit-review";
import { safeQuery, type SafeQueryResult } from "@/lib/errors/safe-query";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { DeclinedDepositDecision } from "./declined-deposit-decision";
import {
  DeclinedDepositsCountSkeleton,
  DeclinedDepositsHeader,
  DeclinedDepositsSkeleton,
} from "./declined-deposits-skeleton";

export const metadata = { title: "Admin Deposit Decisions" };

/** Same bound the other antifraud routes use. The read is a single ADMIN-DB
 *  statement, but an untimed await here blocks the whole segment. */
const QUERY_TIMEOUT_MS = 10_000;

type DeclinedResult = SafeQueryResult<DeclinedFiatCreditReview[]>;

export default async function AdminDepositsPage() {
  await requireAntifraudManagerPage();

  // Started, NOT awaited: the header paints immediately and the count + the
  // decision cards stream in behind their own boundaries off this ONE read.
  // `safeQuery` never rejects, so leaving the promise in flight is safe.
  const casesPromise: Promise<DeclinedResult> = safeQuery(
    () => getDeclinedFiatCreditReviews(),
    [] as DeclinedFiatCreditReview[],
    "antifraud.admin.declined-deposits",
    QUERY_TIMEOUT_MS,
  );

  return (
    <div className="space-y-4">
      <DeclinedDepositsHeader
        count={
          <Suspense fallback={<DeclinedDepositsCountSkeleton />}>
            <DeclinedDepositsCount result={casesPromise} />
          </Suspense>
        }
      />

      <Suspense fallback={<DeclinedDepositsSkeleton />}>
        <DeclinedDepositsContent result={casesPromise} />
      </Suspense>
    </div>
  );
}

async function DeclinedDepositsCount({
  result,
}: {
  result: Promise<DeclinedResult>;
}) {
  const { data, error } = await result;
  return (
    <span className="text-xs text-muted-foreground">
      {error !== null ? "Unavailable" : `${data.length} total`}
    </span>
  );
}

async function DeclinedDepositsContent({
  result,
}: {
  result: Promise<DeclinedResult>;
}) {
  const { data: cases, error, kind } = await result;

  // Money surface: a failed read is stated outright. "No staff-declined Fiat
  // deposits" and "we could not find out" must never look the same here — an
  // unrefunded, unbanned declined deposit sitting invisible is the exact
  // failure this page exists to prevent.
  if (error !== null) {
    return (
      <div
        role="status"
        className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3"
      >
        <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
          The declined-deposit queue could not be loaded
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {kind === "timeout"
            ? "The read timed out. Nothing is listed because of that failure, not because there is nothing to resolve — refresh before concluding anything."
            : "The read failed. Nothing is listed because of that failure, not because there is nothing to resolve."}
        </p>
      </div>
    );
  }

  if (cases.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No staff-declined Fiat deposits have been recorded.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3">
      {cases.map((item) => (
        <Card key={item.id}>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">
                  {formatCurrency(item.amountCents / 100)} declined
                </CardTitle>
                <CardDescription>
                  By {item.decidedByUsername ?? "Unknown staff"} {formatRelative(item.decidedAt)}
                </CardDescription>
              </div>
              <Badge variant={item.status === "resolved" ? "secondary" : "outline"}>
                {item.status.replaceAll("_", " ")}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-[1fr_auto]">
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">Player</p>
                <HostLink href={`/users/${item.userId}`} className="font-mono text-xs hover:underline">
                  {item.userId}
                </HostLink>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Payment</p>
                <HostLink href={`/transactions/card-payments/${item.depositIntentId}`} className="font-mono text-xs hover:underline">
                  {item.providerPaymentId}
                </HostLink>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Refund</p>
                <p>{item.refundStatus.replaceAll("_", " ")}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Ban</p>
                <p>{item.banStatus.replaceAll("_", " ")}</p>
              </div>
              <div className="sm:col-span-2 lg:col-span-4">
                <p className="text-xs text-muted-foreground">Staff reason</p>
                <p>{item.decisionReason}</p>
                {(item.lastError || item.containmentError) && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {item.lastError ?? item.containmentError}
                  </p>
                )}
              </div>
            </div>
            <DeclinedDepositDecision
              caseId={item.id}
              amount={formatCurrency(item.amountCents / 100)}
              refundStatus={item.refundStatus}
              status={item.status}
              version={item.version}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
