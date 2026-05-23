import { notFound } from "next/navigation";
import Link from "next/link";
import {
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
import {
  amountColorFor,
  amountSignFor,
  ledgerDirection,
} from "@/lib/utils/ledger-direction";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Transaction Detail" };

const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-700/90 text-zinc-100",
  uncommon: "bg-emerald-700/90 text-emerald-100",
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

  // House-POV direction for this ledger row — drives the Amount KPI and
  // inline amount colors so a deposit reads green, a withdrawal reads
  // red, a wager reads green, etc. (never mixed per-row).
  const direction = ledgerDirection(data.type);
  const amountColor = amountColorFor(direction);
  const amountSign = amountSignFor(direction);
  const absAmount = Math.abs(data.amount);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Receipt}
          backHref="/transactions"
          title="Transaction"
          badges={
            <>
              <Badge variant="outline" className={STATUS_COLORS[data.status] ?? ""}>
                {data.status}
              </Badge>
              <Badge variant="outline">{data.type.replace(/_/g, " ")}</Badge>
            </>
          }
          subtitle={data.id}
          subtitleClassName="font-mono truncate"
        />
      </PageHero>

      {/* KPI strip — Amount KPI is colored from the HOUSE's perspective,
          not the signed balance delta. A withdrawal decreases the user's
          balance (negative delta) but is a HOUSE loss, so it has to read
          as rose; a wager also decreases the balance but is a HOUSE gain,
          so emerald — the sign of the delta alone is the wrong signal. */}
      <div className="grid gap-2.5 sm:gap-4 grid-cols-1 sm:grid-cols-3">
        <KpiTile
          label="Amount"
          value={`${amountSign}${formatCurrency(absAmount)}`}
          icon={Coins}
          accent={direction === "house-gain" ? "emerald" : direction === "house-loss" ? "rose" : "blue"}
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
          <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
            <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
              <div className="relative p-4 sm:p-5 space-y-3">
                <InfoRow label="User">
                  <Link href={`/users/${data.userId}`} className="hover:underline">
                    {data.username ?? data.email ?? data.userId}
                  </Link>
                </InfoRow>
                <InfoRow label="Type">
                  <Badge variant="outline">{data.type.replace(/_/g, " ")}</Badge>
                </InfoRow>
                <InfoRow label="Amount">
                  <span className={`font-medium tabular-nums ${amountColor}`}>
                    {amountSign}
                    {formatCurrency(absAmount)}
                  </span>
                </InfoRow>
                <InfoRow label="Balance Before">
                  <span className="tabular-nums">{formatCurrency(data.balanceBefore)}</span>
                </InfoRow>
                <InfoRow label="Balance After">
                  <span className="tabular-nums">{formatCurrency(data.balanceAfter)}</span>
                </InfoRow>
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
                    <span className="text-rose-400">{data.failureReason}</span>
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

                {/* Breakdown — inside details card.
                    Colors and signs are from the HOUSE's perspective:
                    the user paying us for packs = GREEN (+), the cards we
                    hand back = RED (−), so the "Net result" row shows the
                    HOUSE profit/loss on this opening — positive = we kept
                    money, negative = the user pulled above bet value. */}
                {data.gameSession && (
                  <div className="border-t pt-3 mt-3">
                    <p className="text-xs text-muted-foreground font-medium mb-2">Breakdown</p>
                    <div className="space-y-1 text-sm font-mono">
                      {data.gameSession.packs.map((pack, i) => (
                        <div key={i} className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
                          <span className="truncate mr-4">
                            {pack.quantity > 1 ? `${pack.quantity}× ` : ""}{pack.name} @ {formatCurrency(pack.priceUsd)}
                          </span>
                          <span className="shrink-0">+{formatCurrency(pack.priceUsd * pack.quantity)}</span>
                        </div>
                      ))}
                      {(() => {
                        const packsCost = data.gameSession!.packs.reduce((s, p) => s + p.priceUsd * p.quantity, 0);
                        const diff = packsCost - data.gameSession!.betAmount;
                        // Discount / borrow: the user paid less than the
                        // sticker cost — house gave up that delta, so
                        // rose.
                        if (Math.abs(diff) > 0.01) {
                          return (
                            <div className="flex items-center justify-between text-rose-600 dark:text-rose-400">
                              <span>Discount / Borrow</span>
                              <span className="shrink-0">-{formatCurrency(diff)}</span>
                            </div>
                          );
                        }
                        return null;
                      })()}
                      <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400 font-semibold border-b pb-1 mb-1">
                        <span>Total received</span>
                        <span>+{formatCurrency(data.gameSession.betAmount)}</span>
                      </div>
                      {data.gameSession.cardsObtained.map((card, i) => (
                        <div key={i} className="flex items-center justify-between text-rose-600 dark:text-rose-400">
                          <span className="truncate mr-4">
                            − {card.name}
                            {card.rarity && <span className="text-muted-foreground text-xs ml-1">({card.rarity})</span>}
                          </span>
                          <span className="shrink-0">-{formatCurrency(card.valueAtObtained)}</span>
                        </div>
                      ))}
                      {data.gameSession.relatedTransactions
                        .filter((rt) => rt.id !== data.id && rt.type !== "pack_opening")
                        .map((rt) => {
                          // Related ledger rows (battle refunds, voucher
                          // exchanges, etc.) — classify each individually.
                          const relDir = ledgerDirection(rt.type);
                          return (
                            <div
                              key={rt.id}
                              className={`flex items-center justify-between ${amountColorFor(relDir)}`}
                            >
                              <span className="truncate mr-4">{rt.type.replace(/_/g, " ")}</span>
                              <span className="shrink-0">
                                {amountSignFor(relDir)}
                                {formatCurrency(Math.abs(rt.amount))}
                              </span>
                            </div>
                          );
                        })}
                      <div className="border-t pt-1 mt-2 flex items-center justify-between font-semibold">
                        <span className="text-foreground">House net</span>
                        {(() => {
                          const totalPayout = data.gameSession!.cardsObtained.reduce((s, c) => s + c.valueAtObtained, 0);
                          // `relatedTransactions.amount` is the user-side
                          // signed delta already. Flip its sign to get
                          // the house contribution for this session.
                          const otherHouseImpact = data.gameSession!.relatedTransactions
                            .filter((rt) => rt.id !== data.id && rt.type !== "pack_opening")
                            .reduce((s, rt) => s - rt.amount, 0);
                          // House net = what we received − what we paid
                          // out (cards + related user-side credits).
                          const houseNet =
                            data.gameSession!.betAmount -
                            totalPayout +
                            otherHouseImpact;
                          const positive = houseNet >= 0;
                          return (
                            <span
                              className={
                                positive
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-rose-600 dark:text-rose-400"
                              }
                            >
                              {positive ? "+" : ""}
                              {formatCurrency(houseNet)}
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
                <div className="relative p-4 sm:p-5 space-y-4">
                  <div className="flex items-center gap-2">
                    <Boxes className="size-4 text-blue-500" />
                    <h3 className="text-sm font-medium">
                      {data.gameSession.gameType === "pack" ? "Pack Opening" : "Battle"} Details
                    </h3>
                  </div>
                  {data.gameSession.packs.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground font-medium">
                        {data.gameSession.packs.length === 1
                          ? `Pack${data.gameSession.packs[0].quantity > 1 ? ` (×${data.gameSession.packs[0].quantity})` : ""}`
                          : "Packs"}
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
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
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
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
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs text-muted-foreground">Payout (at obtained)</span>
                          {/* House-POV: cards handed to the user are value
                              leaving the house → house loss → rose. Matches
                              the Payout column on the list views. */}
                          <span className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
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
                <div className="relative p-4 sm:p-5 space-y-3">
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
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm min-w-0 break-words">{children}</span>
    </div>
  );
}
