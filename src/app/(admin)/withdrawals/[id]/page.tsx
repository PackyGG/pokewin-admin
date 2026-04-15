import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getWithdrawalDetail } from "@/lib/queries/withdrawals";
import { requirePageAccess } from "@/lib/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { StatusTimeline } from "./status-timeline";
import { WithdrawalActionButtons } from "./action-buttons";
import { CardImage } from "@/components/card-image";
import { CopyableAddress } from "./copyable-address";

export const metadata = { title: "Withdrawal Detail" };

const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-700/90 text-zinc-100",
  uncommon: "bg-green-700/90 text-green-100",
  rare: "bg-blue-700/90 text-blue-100",
  "ultra rare": "bg-purple-700/90 text-purple-100",
  "secret rare": "bg-yellow-600/90 text-yellow-100",
  legendary: "bg-orange-600/90 text-orange-100",
  holo: "bg-cyan-700/90 text-cyan-100",
  secret: "bg-pink-700/90 text-pink-100",
};

export default async function WithdrawalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("/withdrawals");
  const { id } = await params;
  const data = await getWithdrawalDetail(id);

  if (!data) notFound();

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
      {/* Header + Timeline + Actions + Details — single card */}
      <Card>
        <CardContent className="pt-6 space-y-6">
          {/* Header: back + title | timeline | actions — single row */}
          <div className="flex items-center gap-6">
            <Link href="/withdrawals" className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground shrink-0">
              <ArrowLeft className="size-4" />
            </Link>
            <div className="shrink-0">
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold">Withdrawal</h1>
                <Badge variant="outline" className={STATUS_COLORS[data.status]}>{data.status}</Badge>
                <Badge variant="outline">{data.method}</Badge>
              </div>
              <p className="font-mono text-xs text-muted-foreground mt-0.5">{data.id}</p>
            </div>
            <div className="flex-1 flex justify-center">
              <StatusTimeline steps={timelineSteps} />
            </div>
            <WithdrawalActionButtons
              withdrawalId={data.id}
              status={data.status}
              method={data.method}
            />
          </div>

          {/* Details */}
          <div className="grid gap-6 md:grid-cols-2 border-t pt-4">
            {/* Left: core details */}
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">Details</p>
              <InfoRow label="User">
                <Link href={`/users/${data.userId}`} className="text-blue-400 hover:underline">
                  {data.username}
                </Link>
              </InfoRow>
              <InfoRow label="Method">{data.method}</InfoRow>
              <InfoRow label="Total Value">{formatCurrency(data.totalValueUsd)}</InfoRow>
              {data.shippingFeeUsd > 0 && (
                <InfoRow label="Shipping Fee">{formatCurrency(data.shippingFeeUsd)}</InfoRow>
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
                  <span className="text-red-400">{data.failureReason}</span>
                </InfoRow>
              )}
            </div>

            {/* Right: shipping or crypto */}
            <div className="space-y-3">
              {data.method === "physical" && shippingSnapshot && (
                <>
                  <p className="text-xs font-medium text-muted-foreground mb-2">Shipping Address</p>
                  <CopyableAddress address={shippingSnapshot} />
                </>
              )}
              {data.method === "crypto" && (
                <>
                  <p className="text-xs font-medium text-muted-foreground mb-2">Crypto Details</p>
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
        </CardContent>
      </Card>

      {/* Vouchers */}
      {data.vouchers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Vouchers ({data.vouchers.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {data.vouchers.map((voucher) => (
                <div key={voucher.id} className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-sm font-medium">{formatCurrency(voucher.value)}</p>
                    <p className="text-xs text-muted-foreground">
                      {voucher.origin}{voucher.description ? ` — ${voucher.description}` : ""}
                    </p>
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">{voucher.id.slice(0, 8)}...</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Items grid */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Items ({data.items.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.items.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">No items</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
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
        </CardContent>
      </Card>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}
