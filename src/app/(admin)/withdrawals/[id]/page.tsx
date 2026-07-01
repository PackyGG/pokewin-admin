import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowUpFromLine, Package, Ticket, Layers } from "lucide-react";
import { getWithdrawalDetail } from "@/lib/queries/withdrawals";
import { requirePageAccess } from "@/lib/dal";
import { isUuid } from "@/lib/utils/ids";
import { isWithdrawalLocked } from "@/lib/withdrawal-lock/lock";
import { safeQueryOrNull, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { Badge } from "@/components/ui/badge";
import { STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { StatusTimeline } from "./status-timeline";
import { WithdrawalActionButtons } from "./action-buttons";
import { CardImage } from "@/components/card-image";
import { CopyableAddress } from "./copyable-address";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  GridSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { EmptyState } from "@/components/empty-state";
import { FadeIn } from "@/components/fade-in";
import { RARITY_COLORS } from "../../transactions/_shared/rarity-colors";

export const metadata = { title: "Withdrawal Detail" };

export default async function WithdrawalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("/withdrawals");
  const { id } = await params;
  // Shape-check UUID before any DB call — see src/lib/utils/ids.ts.
  if (!isUuid(id)) notFound();

  // Shell-first: the PageHero + back affordance paint IMMEDIATELY (the id
  // comes from the route params, no DB needed), and the heavy multi-round-
  // trip withdrawal read streams in behind its own <Suspense> boundary.
  // Never top-level-await the read here — that blocks first paint on the
  // whole fan-out (and, if it threw, white-screens the route).
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ArrowUpFromLine}
          backHref="/withdrawals"
          title="Withdrawal"
          subtitle={id}
          subtitleClassName="font-mono truncate"
        />
      </PageHero>

      <Suspense fallback={<WithdrawalDetailBodySkeleton />}>
        <WithdrawalDetailBody id={id} />
      </Suspense>
    </div>
  );
}

/** Streamed detail body: does the heavy read (safeQuery-wrapped) + the
 *  withdrawal-lock gate, then renders the status badges / timeline / action
 *  buttons + KPI strip + all detail sections. Split out of the page so the
 *  shell above can paint before this resolves. */
async function WithdrawalDetailBody({ id }: { id: string }) {
  // safeQuery-wrap the heavy read: a throw (schema drift, pool timeout) or a
  // slow scan degrades to a fallback band instead of hitting the route error
  // boundary and white-screening the page. `null` on a clean miss means the
  // withdrawal genuinely doesn't exist → 404 (preserves not-found semantics).
  const { data, error, kind } = await safeQueryOrNull(
    () => getWithdrawalDetail(id),
    "withdrawals.detail",
    REWARD_QUERY_TIMEOUT_MS,
  );

  // Hard failure / timeout — degrade to a band (never echo the raw error
  // string) rather than 404; a slow/failed read must not be misreported as
  // "no such withdrawal".
  if (error) {
    return (
      <TileErrorFallback
        label="Withdrawal"
        kind={kind ?? "error"}
        hint="Refresh to retry."
        size="panel"
      />
    );
  }

  if (!data) notFound();

  // Withdrawal-lock gate: if the withdrawal's owning user is currently LOCKED
  // (on the excluded_users blacklist AND not motha-unlocked), treat the detail
  // as non-existent (404) so a locked user's withdrawal — amount, method,
  // items, shipping/crypto details — is never viewable or actionable via a
  // direct link. A motha-granted per-user unlock lifts the 404 so their
  // withdrawal becomes viewable + actionable again. Fail-safe (see lock.ts):
  // any admin-DB fault leaves an excluded user LOCKED.
  if (await isWithdrawalLocked(data.userId)) notFound();

  const timelineSteps = [
    { label: "Pending", date: data.requestedAt, active: data.status === "pending" },
    { label: "Processing", date: data.processingAt, active: data.status === "processing" },
    ...(data.method === "physical"
      ? [{ label: "Shipped", date: data.shippedAt, active: data.status === "shipped" }]
      : []),
    {
      label: "Completed",
      date: data.completedAt,
      active: data.status === "completed",
      failed: data.status === "failed" || data.status === "cancelled",
    },
  ];

  const shippingSnapshot = data.shippingAddressSnapshot as Record<string, string> | null;

  return (
    <div className="space-y-6">
      {/* Status badges + timeline + action buttons — stream in with the body
          (they need the read). Grouped in a compact header card so the
          shell hero above can paint immediately. */}
      <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={STATUS_COLORS[data.status]}>{data.status}</Badge>
            <Badge variant="outline">{data.method}</Badge>
          </div>
          <div className="w-full sm:w-auto">
            <WithdrawalActionButtons
              withdrawalId={data.id}
              status={data.status}
              method={data.method}
            />
          </div>
        </div>
        <div className="mt-4 sm:mt-6 -mx-3 sm:-mx-0 px-3 sm:px-0 flex justify-start sm:justify-center overflow-x-auto">
          <StatusTimeline steps={timelineSteps} />
        </div>
      </div>

      {/* KPI strip — withdrawals are money leaving the house, so the
          Total Value KPI is accented rose (house loss) per CLAUDE.md.
          Shipping Fee is paid BY the user to cover shipping → house
          gain → emerald. */}
      <div className="grid gap-2.5 sm:gap-4 grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Total Value"
          value={formatCurrency(data.totalValueUsd)}
          icon={ArrowUpFromLine}
          accent="rose"
        />
        {data.shippingFeeUsd > 0 && (
          <KpiTile
            label="Shipping Fee"
            value={formatCurrency(data.shippingFeeUsd)}
            icon={Package}
            accent="emerald"
          />
        )}
        <KpiTile
          label="Items"
          value={String(data.items.length)}
          icon={Layers}
          accent="blue"
        />
        {data.vouchers.length > 0 && (
          <KpiTile
            label="Vouchers"
            value={String(data.vouchers.length)}
            icon={Ticket}
            accent="purple"
          />
        )}
      </div>

      {/* Details panel */}
      <FadeIn>
        <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
          <div className="relative p-4 sm:p-5 md:p-6 grid gap-4 sm:gap-6 md:grid-cols-2">
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Details
              </p>
              <InfoRow label="User">
                <Link href={`/users/${data.userId}`} className="text-blue-400 hover:underline">
                  {data.username}
                </Link>
              </InfoRow>
              <InfoRow label="Method">{data.method}</InfoRow>
              {/* House-POV: the withdrawal value is money leaving the house
                  (user takes it out) → house loss → rose. The shipping fee
                  is paid BY the user to cover shipping → house gain →
                  emerald. Matches the KPI strip above. */}
              <InfoRow label="Total Value">
                <span className="font-medium tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(data.totalValueUsd)}
                </span>
              </InfoRow>
              {data.shippingFeeUsd > 0 && (
                <InfoRow label="Shipping Fee">
                  <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                    {formatCurrency(data.shippingFeeUsd)}
                  </span>
                </InfoRow>
              )}
              <InfoRow label="Requested">{formatDateTime(data.requestedAt)}</InfoRow>
              {data.processingAt && <InfoRow label="Processing">{formatDateTime(data.processingAt)}</InfoRow>}
              {data.processedBy && <InfoRow label="Processed By">{data.processedBy}</InfoRow>}
              {data.shippedAt && <InfoRow label="Shipped">{formatDateTime(data.shippedAt)}</InfoRow>}
              {data.shippedBy && <InfoRow label="Shipped By">{data.shippedBy}</InfoRow>}
              {data.trackingNumber && <InfoRow label="Tracking">{data.trackingNumber}</InfoRow>}
              {data.carrier && <InfoRow label="Carrier">{data.carrier}</InfoRow>}
              {data.completedAt && <InfoRow label="Completed">{formatDateTime(data.completedAt)}</InfoRow>}
              {data.failureReason && (
                <InfoRow label="Failure Reason">
                  <span className="text-rose-400">{data.failureReason}</span>
                </InfoRow>
              )}
            </div>

            <div className="space-y-3">
              {data.method === "physical" && shippingSnapshot && (
                <>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Shipping Address
                  </p>
                  <CopyableAddress address={shippingSnapshot} />
                </>
              )}
              {data.method === "crypto" && (
                <>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Crypto Details
                  </p>
                  {data.cryptoAsset && <InfoRow label="Asset">{data.cryptoAsset}</InfoRow>}
                  {data.cryptoAmount > 0 && <InfoRow label="Amount">{data.cryptoAmount}</InfoRow>}
                  {data.destinationAddress && (
                    <InfoRow label="Address">
                      <span className="font-mono text-xs break-all">{data.destinationAddress}</span>
                    </InfoRow>
                  )}
                  {data.txHash && (
                    <InfoRow label="TX Hash">
                      <span className="font-mono text-xs break-all">{data.txHash}</span>
                    </InfoRow>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </FadeIn>

      {/* Vouchers */}
      {data.vouchers.length > 0 && (
        <div className="space-y-3">
          <SectionHeading
            icon={Ticket}
            title={`Vouchers (${data.vouchers.length})`}
          />
          <FadeIn>
            <div className="rounded-2xl border bg-card/60 p-4">
              <div className="divide-y">
                {data.vouchers.map((voucher) => (
                  <div key={voucher.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      {/* House-POV: a voucher is value the house owes the
                          user (a perk we credited) → house loss → rose. */}
                      <p className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(voucher.value)}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {voucher.origin}{voucher.description ? ` — ${voucher.description}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{voucher.id.slice(0, 8)}...</span>
                  </div>
                ))}
              </div>
            </div>
          </FadeIn>
        </div>
      )}

      {/* Items grid */}
      <div className="space-y-3">
        <SectionHeading
          icon={Layers}
          title={`Items (${data.items.length})`}
        />
        <FadeIn>
          <div className="rounded-2xl border bg-card/60 p-3 sm:p-4">
            {data.items.length === 0 ? (
              <EmptyState
                icon={Layers}
                title="No items in this withdrawal"
                description="This request has no card items attached — it may be a crypto-only or voucher-only withdrawal."
                compact
              />
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5 sm:gap-3">
                {data.items.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-lg border bg-card overflow-hidden"
                  >
                    <div className="aspect-[2/3] relative bg-muted">
                      <CardImage
                        src={item.imageUrl}
                        alt={item.cardName}
                        className="size-full rounded-t-lg"
                      />
                      {item.rarity && (
                        <span
                          className={`absolute bottom-1.5 left-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold leading-none shadow backdrop-blur-sm ${RARITY_COLORS[item.rarity.toLowerCase()] ?? "bg-black/80 text-white"}`}
                        >
                          {item.rarity}
                        </span>
                      )}
                    </div>
                    <div className="p-2 space-y-0.5">
                      <p className="text-xs font-medium truncate" title={item.cardName}>
                        {item.cardName}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatCurrency(item.value)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </FadeIn>
      </div>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm min-w-0 break-words">{children}</span>
    </div>
  );
}

/**
 * Fallback for the streamed <WithdrawalDetailBody> — the BODY only (the
 * PageHero shell already painted in the page above). Mirrors the body of
 * the route's loading.tsx: a header card (status badges + timeline + action
 * buttons), a 4-tile KPI strip, the full-width Details panel, and the items
 * grid — so the swap-in is shift-free.
 */
function WithdrawalDetailBodySkeleton() {
  return (
    <div className="space-y-6">
      {/* Header card: badges + action buttons + timeline. */}
      <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-6 w-20 rounded-md" />
            <Skeleton className="h-6 w-16 rounded-md" />
          </div>
          <Skeleton className="h-9 w-full max-w-[140px] rounded-md sm:w-28" />
        </div>
        <div className="mt-4 flex justify-start sm:mt-6 sm:justify-center">
          <Skeleton className="h-8 w-64 rounded-md" />
        </div>
      </div>
      <KpiStripSkeleton count={4} />
      <Skeleton className="h-72 rounded-2xl" />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={100} />
        <GridSkeleton count={6} cols={6} aspect="card" />
      </div>
    </div>
  );
}
