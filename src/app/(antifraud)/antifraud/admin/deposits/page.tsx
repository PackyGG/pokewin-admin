import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HostLink } from "@/components/host-link";
import { getDeclinedFiatCreditReviews } from "@/lib/antifraud/fiat-credit-review";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { DeclinedDepositDecision } from "./declined-deposit-decision";

export const metadata = { title: "Admin Deposit Decisions" };

export default async function AdminDepositsPage() {
  await requireAntifraudManagerPage();
  const cases = await getDeclinedFiatCreditReviews();

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Declined deposits</h1>
          <p className="text-sm text-muted-foreground">
            Decide whether each declined payment should be refunded, the account banned, or both.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">{cases.length} total</span>
      </div>

      {cases.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No staff-declined Fiat deposits have been recorded.
          </CardContent>
        </Card>
      ) : (
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
      )}
    </div>
  );
}
