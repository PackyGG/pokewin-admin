import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRightLeft, CircleDollarSign, CreditCard, DatabaseZap, Info, ReceiptText, Webhook } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { KpiTile, PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { KpiStripSkeleton, SectionHeadingSkeleton } from "@/components/loading-skeletons";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { requirePageAccess } from "@/lib/dal";
import { safeQueryOrNull, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { getCardPaymentDetail } from "@/lib/queries/card-payments";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { isUuid } from "@/lib/utils/ids";
import { whopPaymentMethodLabel } from "@/lib/whop-payment-method";

export const metadata = { title: "Card Payment Detail" };

const STATUS_CLASSES: Record<string, string> = {
  completed: "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  checkout_creating: "border-slate-500/30 bg-slate-500/15 text-slate-600 dark:text-slate-400",
  checkout_ready: "border-cyan-500/30 bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
  pending: "border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400",
  review: "border-orange-500/30 bg-orange-500/15 text-orange-600 dark:text-orange-400",
  failed: "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400",
  canceled: "border-slate-500/30 bg-slate-500/15 text-slate-600 dark:text-slate-400",
  partially_refunded: "border-violet-500/30 bg-violet-500/15 text-violet-600 dark:text-violet-400",
  refunded: "border-purple-500/30 bg-purple-500/15 text-purple-600 dark:text-purple-400",
  disputed: "border-red-500/30 bg-red-500/15 text-red-600 dark:text-red-400",
};

function usd(cents: number | null): string {
  return cents == null ? "—" : formatCurrency(cents / 100);
}

export default async function CardPaymentDetailPage({ params }: { params: Promise<{ intentId: string }> }) {
  await requirePageAccess("/transactions/deposits");
  const { intentId } = await params;
  if (!isUuid(intentId)) notFound();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity backHref="/transactions/deposits?tab=card-payments" />
      </PageHero>
      <Suspense fallback={<CardPaymentDetailSkeleton />}>
        <CardPaymentDetailBody intentId={intentId} />
      </Suspense>
    </div>
  );
}

async function CardPaymentDetailBody({ intentId }: { intentId: string }) {
  const { data, error, kind } = await safeQueryOrNull(
    () => getCardPaymentDetail(intentId),
    "transactions.card-payments.detail",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error) {
    return <TileErrorFallback label="Card payment" kind={kind ?? "error"} hint="The PostgreSQL query failed. Refresh to retry." size="panel" />;
  }
  if (!data) notFound();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={STATUS_CLASSES[data.status] ?? ""}>{data.status.replaceAll("_", " ")}</Badge>
        <Badge variant="outline">{data.provider}</Badge>
        {data.providerPaymentStatus && <Badge variant="secondary">Provider: {data.providerPaymentStatus}</Badge>}
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground"><DatabaseZap className="size-3" />PostgreSQL</span>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Customer paid" value={usd(data.actualCustomerTotalCents)} icon={CreditCard} accent="emerald" />
        <KpiTile label="Credited" value={usd(data.creditedAmountCents)} icon={CircleDollarSign} accent="cyan" />
        <KpiTile label="Provider net" value={usd(data.providerNetAmountCents)} icon={ArrowRightLeft} accent="blue" />
        <KpiTile label="Provider fees" value={usd(data.feeAmountCents)} icon={ReceiptText} accent="rose" />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Info} title="Payment and reconciliation" />
        <FadeIn className="grid gap-3 lg:grid-cols-2">
          <DetailCard title="Payment intent">
            <InfoRow label="User"><Link href={`/users/${data.userId}`} className="hover:underline">{data.username ?? data.email ?? data.userId}</Link></InfoRow>
            <InfoRow label="Requested">{usd(data.requestedAmountCents)}</InfoRow>
            <InfoRow label="Currency">{data.currency}</InfoRow>
            <InfoRow label="Payment method">
              <span>
                {whopPaymentMethodLabel(data.paymentMethodType)}
                {data.paymentMethodType === "apple_pay" && (
                  <span className="ml-1 text-xs text-emerald-600 dark:text-emerald-400">
                    · 20% lower antifraud weight
                  </span>
                )}
              </span>
            </InfoRow>
            {data.cardBrand && <InfoRow label="Card brand">{data.cardBrand.toUpperCase()}</InfoRow>}
            {data.cardLast4 && <InfoRow label="Card ending">•••• {data.cardLast4}</InfoRow>}
            <InfoRow label="Checkout ID"><CodeValue value={data.providerCheckoutId} /></InfoRow>
            <InfoRow label="Payment ID"><CodeValue value={data.providerPaymentId} /></InfoRow>
            <InfoRow label="Idempotency key"><CodeValue value={data.clientIdempotencyKey} /></InfoRow>
            <InfoRow label="Created">{formatDateTime(data.createdAt)}</InfoRow>
            <InfoRow label="Updated">{formatDateTime(data.updatedAt)}</InfoRow>
            {data.paidAt && <InfoRow label="Paid">{formatDateTime(data.paidAt)}</InfoRow>}
            {data.completedAt && <InfoRow label="Completed">{formatDateTime(data.completedAt)}</InfoRow>}
            {data.failureReason && <InfoRow label="Failure / review reason"><span className="text-rose-600 dark:text-rose-400">{data.failureReason}</span></InfoRow>}
          </DetailCard>

          <DetailCard title="Ledger reconciliation">
            <InfoRow label="Ledger ID">
              {data.completedLedgerId ? <Link href={`/transactions/${data.completedLedgerId}`} className="font-mono text-xs hover:underline">{data.completedLedgerId}</Link> : "—"}
            </InfoRow>
            <InfoRow label="Ledger status">{data.ledgerStatus ?? "—"}</InfoRow>
            <InfoRow label="Ledger amount">{data.ledgerAmount == null ? "—" : formatCurrency(data.ledgerAmount)}</InfoRow>
            <InfoRow label="Balance before">{data.ledgerBalanceBefore == null ? "—" : formatCurrency(data.ledgerBalanceBefore)}</InfoRow>
            <InfoRow label="Balance after">{data.ledgerBalanceAfter == null ? "—" : formatCurrency(data.ledgerBalanceAfter)}</InfoRow>
            <InfoRow label="Description">{data.ledgerDescription ?? "—"}</InfoRow>
            <div className="border-t pt-3 text-xs text-muted-foreground">This is a read-only reconciliation view. Balance and ledger mutations remain owned by the backend payment workflow.</div>
          </DetailCard>
        </FadeIn>
      </div>

      <div className="space-y-3">
        <SectionHeading icon={ReceiptText} title="Provider fees" />
        <FadeIn><div className="overflow-hidden rounded-2xl border bg-card/60">
          {data.fees.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No fee rows.</p> : <div className="divide-y">
            {data.fees.map((fee) => <div key={fee.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div><p className="text-sm font-medium">{fee.feeName}</p><p className="font-mono text-[10px] text-muted-foreground">{fee.feeType} · {fee.feeKey}</p></div>
              <div className="text-right"><p className="font-medium tabular-nums text-rose-600 dark:text-rose-400">{usd(fee.amountCents)}</p><p className="text-[10px] text-muted-foreground">{formatDateTime(fee.createdAt)}</p></div>
            </div>)}
          </div>}
        </div></FadeIn>
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Webhook} title="Webhook timeline" />
        <FadeIn><div className="overflow-hidden rounded-2xl border bg-card/60">
          {data.webhookEvents.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No webhook events matched this payment or checkout ID.</p> : <div className="divide-y">
            {data.webhookEvents.map((event) => <details key={event.id} className="group p-4">
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
                <div><p className="text-sm font-medium">{event.eventType}</p><p className="font-mono text-[10px] text-muted-foreground">{event.providerEventId}</p></div>
                <div className="text-right"><Badge variant="outline">{event.processingStatus}</Badge><p className="mt-1 text-[10px] text-muted-foreground">{formatDateTime(event.receivedAt)}</p></div>
              </summary>
              <div className="mt-3 space-y-2 border-t pt-3">{event.lastError && <p className="text-xs text-rose-600 dark:text-rose-400">{event.lastError}</p>}<JsonBlock value={event.payload} /></div>
            </details>)}
          </div>}
        </div></FadeIn>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <JsonPanel title="Pricing metadata" value={data.pricingMetadata} />
        <JsonPanel title="Provider metadata" value={data.providerMetadata} />
      </div>
    </div>
  );
}

function DetailCard({ title, children }: { title: string; children: ReactNode }) {
  return <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-4 sm:p-5"><h3 className="mb-4 text-sm font-medium">{title}</h3><div className="space-y-3">{children}</div></div>;
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><span className="text-sm text-muted-foreground">{label}</span><span className="min-w-0 max-w-full break-words text-right text-sm">{children}</span></div>;
}

function CodeValue({ value }: { value: string | null }) {
  return value ? <span className="font-mono text-xs">{value}</span> : <>—</>;
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return <div className="space-y-3"><SectionHeading icon={DatabaseZap} title={title} /><FadeIn><div className="rounded-2xl border bg-card/60 p-4"><JsonBlock value={value} /></div></FadeIn></div>;
}

function JsonBlock({ value }: { value: unknown }) {
  let normalized = value;
  if (typeof value === "string") {
    try { normalized = JSON.parse(value); } catch { normalized = value; }
  }
  return <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed">{JSON.stringify(normalized, null, 2) ?? "null"}</pre>;
}

function CardPaymentDetailSkeleton() {
  return <div className="space-y-6"><div className="flex gap-2"><Skeleton className="h-6 w-20" /><Skeleton className="h-6 w-16" /></div><KpiStripSkeleton count={4} /><div className="space-y-3"><SectionHeadingSkeleton titleWidth={180} /><div className="grid gap-3 lg:grid-cols-2">{Array.from({ length: 2 }).map((_, card) => <div key={card} className="space-y-3 rounded-2xl border p-5"><Skeleton className="h-4 w-32" />{Array.from({ length: 8 }).map((__, row) => <div key={row} className="flex justify-between gap-4"><Skeleton className="h-3.5 w-24" /><Skeleton className="h-3.5 w-36" /></div>)}</div>)}</div></div></div>;
}
