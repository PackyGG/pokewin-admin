import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Receipt,
  Coins,
  ArrowRightLeft,
  Bitcoin,
  Info,
  Boxes,
} from "lucide-react";
import { getTransactionDetail } from "@/lib/queries/transactions";
import { requirePageAccess } from "@/lib/dal";
import { Badge } from "@/components/ui/badge";
import { CardImage } from "@/components/card-image";
import { STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { PageHero, SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Transaction Detail" };

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

export default async function TransactionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Gate on /transactions page access — transaction detail shows balances,
  // crypto addresses, metadata, and should only be visible to roles the
  // admin panel lets view the transactions list itself.
  await requirePageAccess("/transactions");
  const { id } = await params;
  const data = await getTransactionDetail(id);

  if (!data) notFound();

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-4 flex-wrap">
          <Link
            href="/transactions"
            className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground shrink-0"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 shrink-0">
            <Receipt className="size-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold leading-tight">Transaction</h1>
              <Badge variant="outline" className={STATUS_COLORS[data.status] ?? ""}>
                {data.status}
              </Badge>
              <Badge variant="outline">{data.type.replace(/_/g, " ")}</Badge>
            </div>
            <p className="font-mono text-xs text-muted-foreground">{data.id}</p>
          </div>
        </div>
      </PageHero>

      {/* KPI strip */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiTile
          label="Amount"
          value={`${data.amount >= 0 ? "+" : ""}${formatCurrency(data.amount)}`}
          icon={Coins}
          accent={data.amount >= 0 ? "emerald" : "rose"}
        />
        <KpiTile
          label="Balance Before"
          value={formatCurrency(data.balanceBefore)}
          icon={ArrowRightLeft}
          accent="blue"
        />
        <KpiTile
          label="Balance After"
          value={formatCurrency(data.balanceAfter)}
          icon={ArrowRightLeft}
          accent="cyan"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Info} title="Details" />
        <FadeIn>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
              <div className="relative p-5 space-y-3">
                <InfoRow label="User">
                  <Link href={`/users/${data.userId}`} className="hover:underline">
                    {data.username ?? data.email ?? data.userId}
                  </Link>
                </InfoRow>
                <InfoRow label="Type">
                  <Badge variant="outline">{data.type.replace(/_/g, " ")}</Badge>
                </InfoRow>
                <InfoRow label="Amount">
                  <span className={data.amount >= 0 ? "text-green-400" : "text-red-400"}>
                    {data.amount >= 0 ? "+" : ""}{formatCurrency(data.amount)}
                  </span>
                </InfoRow>
                <InfoRow label="Balance Before">{formatCurrency(data.balanceBefore)}</InfoRow>
                <InfoRow label="Balance After">{formatCurrency(data.balanceAfter)}</InfoRow>
                <InfoRow label="Status">
                  <Badge variant="outline" className={STATUS_COLORS[data.status] ?? ""}>
                    {data.status}
                  </Badge>
                </InfoRow>
                <InfoRow label="Description">{data.description}</InfoRow>
                <InfoRow label="Created">{formatDateTime(data.createdAt)}</InfoRow>
                <InfoRow label="Updated">{formatDateTime(data.updatedAt)}</InfoRow>
                {data.failureReason && (
                  <InfoRow label="Failure Reason">
                    <span className="text-red-400">{data.failureReason}</span>
                  </InfoRow>
                )}
                {data.gameSessionId && (
                  <InfoRow label="Game Session">
                    <span className="font-mono text-xs">{data.gameSessionId}</span>
                  </InfoRow>
                )}
                {data.gameSession?.houseEdge != null && (
                  <InfoRow label="House Edge">
                    <span>{data.gameSession.houseEdge.toFixed(2)}%</span>
                  </InfoRow>
                )}

                {/* Breakdown — inside details card */}
                {data.gameSession && (
                  <div className="border-t pt-3 mt-3">
                    <p className="text-xs text-muted-foreground font-medium mb-2">Breakdown</p>
                    <div className="space-y-1 text-sm font-mono">
                      {data.gameSession.packs.map((pack, i) => (
                        <div key={i} className="flex items-center justify-between text-red-400">
                          <span className="truncate mr-4">
                            {pack.quantity > 1 ? `${pack.quantity}× ` : ""}{pack.name} @ {formatCurrency(pack.priceUsd)}
                          </span>
                          <span className="shrink-0">-{formatCurrency(pack.priceUsd * pack.quantity)}</span>
                        </div>
                      ))}
                      {(() => {
                        const packsCost = data.gameSession!.packs.reduce((s, p) => s + p.priceUsd * p.quantity, 0);
                        const diff = packsCost - data.gameSession!.betAmount;
                        if (Math.abs(diff) > 0.01) {
                          return (
                            <div className="flex items-center justify-between text-yellow-400">
                              <span>Discount / Borrow</span>
                              <span className="shrink-0">+{formatCurrency(diff)}</span>
                            </div>
                          );
                        }
                        return null;
                      })()}
                      <div className="flex items-center justify-between text-red-400 font-semibold border-b pb-1 mb-1">
                        <span>Total cost</span>
                        <span>-{formatCurrency(data.gameSession.betAmount)}</span>
                      </div>
                      {data.gameSession.cardsObtained.map((card, i) => (
                        <div key={i} className="flex items-center justify-between text-green-400">
                          <span className="truncate mr-4">
                            + {card.name}
                            {card.rarity && <span className="text-muted-foreground text-xs ml-1">({card.rarity})</span>}
                          </span>
                          <span className="shrink-0">+{formatCurrency(card.valueAtObtained)}</span>
                        </div>
                      ))}
                      {data.gameSession.relatedTransactions
                        .filter((rt) => rt.id !== data.id && rt.type !== "pack_opening")
                        .map((rt) => (
                          <div key={rt.id} className="flex items-center justify-between text-yellow-400">
                            <span className="truncate mr-4">{rt.type.replace(/_/g, " ")}</span>
                            <span className="shrink-0">
                              {rt.amount >= 0 ? "+" : ""}{formatCurrency(rt.amount)}
                            </span>
                          </div>
                        ))}
                      <div className="border-t pt-1 mt-2 flex items-center justify-between font-semibold">
                        <span className="text-foreground">Net result</span>
                        {(() => {
                          const totalPayout = data.gameSession!.cardsObtained.reduce((s, c) => s + c.valueAtObtained, 0);
                          const otherTxs = data.gameSession!.relatedTransactions
                            .filter((rt) => rt.id !== data.id && rt.type !== "pack_opening")
                            .reduce((s, rt) => s + rt.amount, 0);
                          const net = totalPayout - data.gameSession!.betAmount + otherTxs;
                          return (
                            <span className={net >= 0 ? "text-green-400" : "text-red-400"}>
                              {net >= 0 ? "+" : ""}{formatCurrency(net)}
                            </span>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {data.gameSession && (
              <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
                <div className="relative p-5 space-y-4">
                  <h3 className="text-sm font-medium">
                    {data.gameSession.gameType === "pack" ? "Pack Opening" : "Battle"} Details
                  </h3>
                  {data.gameSession.packs.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground font-medium">
                        {data.gameSession.packs.length === 1
                          ? `Pack${data.gameSession.packs[0].quantity > 1 ? ` (×${data.gameSession.packs[0].quantity})` : ""}`
                          : "Packs"}
                      </p>
                      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                        {data.gameSession.packs.map((pack, i) => (
                          <div key={i} className="rounded-lg border bg-card overflow-hidden">
                            <div className="aspect-[2/3] relative bg-muted">
                              <CardImage
                                src={pack.imageUrl}
                                alt={pack.name}
                                className="size-full"
                              />
                            </div>
                            <div className="p-1.5 space-y-0.5">
                              <p className="text-[11px] font-medium truncate" title={pack.name}>
                                {pack.name}
                              </p>
                              <p className="text-[11px] font-medium">{formatCurrency(pack.priceUsd)}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {data.gameSession.cardsObtained.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground font-medium">
                        Cards Obtained ({data.gameSession.cardsObtained.length})
                      </p>
                      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                        {data.gameSession.cardsObtained.map((card, i) => (
                          <div key={i} className="rounded-lg border bg-card overflow-hidden">
                            <div className="aspect-[2/3] relative bg-muted">
                              <CardImage
                                src={card.imageUrl}
                                alt={card.name}
                                className="size-full"
                              />
                              {card.rarity && (
                                <span
                                  className={`absolute bottom-1 left-1 rounded px-1 py-0.5 text-[10px] font-semibold leading-none shadow backdrop-blur-sm ${RARITY_COLORS[card.rarity.toLowerCase()] ?? "bg-black/80 text-white"}`}
                                >
                                  {card.rarity}
                                </span>
                              )}
                            </div>
                            <div className="p-1.5 space-y-0.5">
                              <p className="text-[11px] font-medium truncate" title={card.name}>
                                {card.name}
                              </p>
                              <p className="text-[11px] font-medium">{formatCurrency(card.valueAtObtained)}</p>
                              {card.currentPriceUsd !== card.valueAtObtained && (
                                <p className="text-[10px] text-muted-foreground">
                                  Now {formatCurrency(card.currentPriceUsd)}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="pt-1 border-t">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">Payout (at obtained)</span>
                          <span className="text-sm font-medium">
                            {formatCurrency(data.gameSession.cardsObtained.reduce((s, c) => s + c.valueAtObtained, 0))}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {(data.cryptoAsset || data.blockchainTxHash) && (
              <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
                <div className="relative p-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <Bitcoin className="size-4 text-amber-500" />
                    <h3 className="text-sm font-medium">Crypto Details</h3>
                  </div>
                  {data.cryptoAsset && <InfoRow label="Asset">{data.cryptoAsset}</InfoRow>}
                  {data.cryptoAmount != null && (
                    <InfoRow label="Crypto Amount">{data.cryptoAmount}</InfoRow>
                  )}
                  {data.exchangeRate != null && (
                    <InfoRow label="Exchange Rate">{data.exchangeRate}</InfoRow>
                  )}
                  {data.sourceAddress && (
                    <InfoRow label="Source">
                      <span className="font-mono text-xs break-all">{data.sourceAddress}</span>
                    </InfoRow>
                  )}
                  {data.destinationAddress && (
                    <InfoRow label="Destination">
                      <span className="font-mono text-xs break-all">{data.destinationAddress}</span>
                    </InfoRow>
                  )}
                  {data.blockchainTxHash && (
                    <InfoRow label="TX Hash">
                      <span className="font-mono text-xs break-all">{data.blockchainTxHash}</span>
                    </InfoRow>
                  )}
                </div>
              </div>
            )}
          </div>
        </FadeIn>
      </div>

      {data.metadata && (
        <div className="space-y-3">
          <SectionHeading icon={Boxes} title="Metadata" />
          <FadeIn>
            <div className="rounded-2xl border bg-card/60 p-4">
              <pre className="overflow-auto rounded-md bg-muted p-4 text-xs">
                {JSON.stringify(data.metadata, null, 2)}
              </pre>
            </div>
          </FadeIn>
        </div>
      )}
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
