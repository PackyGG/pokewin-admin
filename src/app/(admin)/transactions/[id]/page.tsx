import { notFound } from "next/navigation";
import Link from "next/link";
import {
  Receipt,
  Coins,
  ArrowRightLeft,
  Bitcoin,
  Info,
  Boxes,
  Ticket,
  ExternalLink,
} from "lucide-react";
import { getTransactionDetail } from "@/lib/queries/transactions";
import { requirePageAccess } from "@/lib/dal";
import { isUuid } from "@/lib/utils/ids";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { Badge } from "@/components/ui/badge";
import { CardImage } from "@/components/card-image";
import { STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import {
  amountColorFor,
  balanceDeltaSign,
  balanceMovementSign,
  ledgerDirection,
} from "@/lib/utils/ledger-direction";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { BattlePasswordReveal } from "@/components/battle-password-reveal";
import { battleUrl } from "@/lib/utils/main-site";

export const metadata = { title: "Transaction Detail" };

// Voucher-excess ledger types are balance-neutral (balance_after ==
// balance_before, so their balance delta is $0). The real value lives in
// the `vouchers` table and is surfaced via `gameSession.voucherValue`, so
// these rows are excluded from the breakdown's related-tx list and from
// the `otherHouseImpact` sum to avoid relying on a $0 delta / double
// counting. Mirrors the special-casing in queries/users-financial.ts.
const VOUCHER_EXCESS_TYPES = new Set([
  "battle_excess_to_voucher",
  "pack_borrow_to_voucher",
  "exchange_excess_to_voucher",
]);

// Withdrawal-type ledger transactions. If a transaction of one of these types
// belongs to a blacklisted user, the detail page 404s so the withdrawal
// amount / crypto address / destination is never viewable via a direct link.
// Scoped to withdrawal types only (not every tx type) — the task is closing
// WITHDRAWAL-info leaks for blacklisted users, and blacklisted users' other
// ledger rows aren't the target here.
const WITHDRAWAL_LEDGER_TYPES = new Set([
  "card_withdrawal",
  "balance_withdrawal",
  "withdrawal_shipping_fee",
]);

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
  // Gate on /transactions/deposits page access — transaction detail shows
  // balances, crypto addresses, metadata. After the standalone /transactions
  // overview was removed, the canonical entry-point into the ledger is the
  // Deposits view, so its permission key is the right gate for the detail
  // pages too. Any role that can read /transactions/deposits can drill into
  // an individual ledger row from any sub-page (packs, rewards, upgrader).
  const session = await requirePageAccess("/transactions/deposits");
  const { id } = await params;
  // Shape-check UUID before any DB call — see src/lib/utils/ids.ts.
  if (!isUuid(id)) notFound();
  const data = await getTransactionDetail(id);

  if (!data) notFound();

  // Blacklist gate: if this is a WITHDRAWAL-type ledger tx belonging to a
  // user on the admin-managed excluded_users blacklist, 404 so the
  // withdrawal amount / crypto destination is never viewable via a direct
  // link. Generic membership check (getExcludedUserIds is the raw fail-closed
  // set) — applies to everyone on the list, no per-user/per-admin override.
  // Scoped to withdrawal-type txs (see WITHDRAWAL_LEDGER_TYPES); the related-
  // transactions list on the page is keyed on game_session_id (pack/battle/
  // upgrader sessions), so it can never surface a withdrawal row.
  if (WITHDRAWAL_LEDGER_TYPES.has(data.type)) {
    const excludedUserIds = await getExcludedUserIds();
    if (excludedUserIds.includes(data.userId)) notFound();
  }

  // House-POV direction for this ledger row — drives the Amount KPI and
  // inline amount COLOR so a deposit reads green, a withdrawal reads
  // red, a wager reads green, etc. (never mixed per-row).
  const direction = ledgerDirection(data.type);
  const amountColor = amountColorFor(direction);
  // SIGN follows the real balance movement (data.amount is itself the signed
  // balanceAfter − balanceBefore delta here), so the Amount can never
  // contradict the Balance Before/After tiles: a credit reads "+", a debit
  // "−", independent of the house-POV color above.
  const amountSign = balanceMovementSign(data.balanceBefore, data.balanceAfter);
  const absAmount = Math.abs(data.amount);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Receipt}
          backHref="/transactions/deposits"
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
                {/* Battle row — linked battle for battle_bet /
                    battle_sponsorship / battle_refund transactions.
                    Direct link to the live battle on packy.gg so admins
                    can spectate without bouncing through /battles. */}
                {data.battleId && (
                  <InfoRow label="Battle">
                    <a
                      href={battleUrl(data.battleId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-xs text-blue-400 break-all hover:underline"
                      title="Open the live battle on packy.gg"
                    >
                      {data.battleId}
                      <ExternalLink className="size-3 shrink-0" />
                    </a>
                  </InfoRow>
                )}
                {/* Battle Password — admin-only, only when the linked
                    battle has a password set. Reuses the same shared
                    BattlePasswordReveal component as /battles/[id] and
                    the user-detail transaction modal so the UX +
                    audit-logging stay in lock-step across surfaces.
                    Defence-in-depth: UI conditional here + role check
                    in revealBattlePassword. */}
                {data.battleId &&
                  data.hasPassword &&
                  session.role === "admin" && (
                    <InfoRow label="Battle Password">
                      <BattlePasswordReveal battleId={data.battleId} />
                    </InfoRow>
                  )}
                {data.gameSession && (
                  <>
                    {/* Items Won = cards + voucher excess handed to the
                        user. House loss → rose. */}
                    <InfoRow label="Items Won">
                      <span className="font-medium tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(data.gameSession.itemsWon)}
                      </span>
                    </InfoRow>
                    {/* House P&L = bet − items won. House POV: positive =
                        house kept money (emerald), negative = user pulled
                        above bet (rose). Replaces the old House Edge %. */}
                    <InfoRow label="House P&L">
                      {(() => {
                        const pnl = data.gameSession!.housePnl;
                        const positive = pnl >= 0;
                        return (
                          <span
                            className={`font-medium tabular-nums ${
                              positive
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-rose-600 dark:text-rose-400"
                            }`}
                          >
                            {positive ? "+" : "-"}
                            {formatCurrency(Math.abs(pnl))}
                          </span>
                        );
                      })()}
                    </InfoRow>
                  </>
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
                        // Skip pack_opening (the row itself) and the
                        // voucher-excess rows: those are balance-neutral
                        // ledger entries (delta = $0). The real voucher
                        // value gets its own line below, sourced from the
                        // vouchers table.
                        .filter(
                          (rt) =>
                            rt.id !== data.id &&
                            rt.type !== "pack_opening" &&
                            !VOUCHER_EXCESS_TYPES.has(rt.type),
                        )
                        .map((rt) => {
                          // Related ledger rows (battle refunds, voucher
                          // exchanges, etc.) — COLOR each individually from the
                          // house POV; SIGN from the row's own balance delta
                          // (rt.amount is already balanceAfter − balanceBefore)
                          // so a credit reads "+" and never fights the value.
                          const relDir = ledgerDirection(rt.type);
                          return (
                            <div
                              key={rt.id}
                              className={`flex items-center justify-between ${amountColorFor(relDir)}`}
                            >
                              <span className="truncate mr-4">{rt.type.replace(/_/g, " ")}</span>
                              <span className="shrink-0">
                                {balanceDeltaSign(rt.amount)}
                                {formatCurrency(Math.abs(rt.amount))}
                              </span>
                            </div>
                          );
                        })}
                      {/* Voucher excess this session spun off — value the
                          user won that isn't a card. House loss → rose. */}
                      {data.gameSession.voucherValue > 0 && (
                        <div className="flex items-center justify-between text-rose-600 dark:text-rose-400">
                          <span className="truncate mr-4">− Voucher excess</span>
                          <span className="shrink-0">
                            -{formatCurrency(data.gameSession.voucherValue)}
                          </span>
                        </div>
                      )}
                      <div className="border-t pt-1 mt-2 flex items-center justify-between font-semibold">
                        <span className="text-foreground">House net</span>
                        {(() => {
                          const totalPayout = data.gameSession!.cardsObtained.reduce((s, c) => s + c.valueAtObtained, 0);
                          // `relatedTransactions.amount` is the user-side
                          // signed delta already. Flip its sign to get
                          // the house contribution for this session. The
                          // voucher-excess rows are excluded (balance-
                          // neutral, counted via voucherValue below).
                          const otherHouseImpact = data.gameSession!.relatedTransactions
                            .filter(
                              (rt) =>
                                rt.id !== data.id &&
                                rt.type !== "pack_opening" &&
                                !VOUCHER_EXCESS_TYPES.has(rt.type),
                            )
                            .reduce((s, rt) => s - rt.amount, 0);
                          // House net = what we received − what we paid
                          // out (cards + voucher excess + related user-side
                          // credits).
                          const houseNet =
                            data.gameSession!.betAmount -
                            totalPayout -
                            data.gameSession!.voucherValue +
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
                      {data.gameSession.gameType === "pack"
                        ? "Pack Opening"
                        : data.gameSession.gameType === "upgrader"
                          ? "Upgrader"
                          : "Battle"}{" "}
                      Details
                    </h3>
                  </div>
                  {data.gameSession.packs.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground font-medium">
                        {data.gameSession.packs.length === 1
                          ? `Pack${data.gameSession.packs[0].quantity > 1 ? ` (×${data.gameSession.packs[0].quantity})` : ""}`
                          : "Packs"}
                      </p>
                      <FadeIn speed="fast" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
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
                      </FadeIn>
                    </div>
                  )}
                  {data.gameSession.cardsObtained.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground font-medium">
                        Cards Obtained ({data.gameSession.cardsObtained.length})
                      </p>
                      <FadeIn speed="fast" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
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
                      </FadeIn>
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

            {/* Provably Fair — one card per PF roll on this session.
                For an upgrader spin this is the single "ticket they
                hit" admins want to verify; for pack opens it's one
                row per card pulled; for battles it's the per-result
                draws inside this user's session. Each card pairs the
                ticket number (the random draw) with the card it
                landed on (when the PF row links to a kept inventory
                item) so the outcome can be audited end-to-end without
                opening the modal on /users/[id]. */}
            {data.gameSession && data.gameSession.pfResults.length > 0 && (
              <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 lg:col-span-2">
                <div className="relative p-4 sm:p-5 space-y-4">
                  <div className="flex items-center gap-2">
                    <Ticket className="size-4 text-pink-500" />
                    <h3 className="text-sm font-medium">
                      Provably Fair · {data.gameSession.pfResults.length}{" "}
                      {data.gameSession.pfResults.length === 1
                        ? "roll"
                        : "rolls"}
                    </h3>
                  </div>
                  <FadeIn speed="fast" className="grid gap-3 sm:gap-4 md:grid-cols-2">
                    {data.gameSession.pfResults.map((pf, i) => (
                      <div
                        key={pf.id}
                        className="rounded-xl border bg-muted/30 p-3 sm:p-4 space-y-3"
                      >
                        <div className="flex items-start justify-between gap-3 flex-wrap">
                          <div className="space-y-0.5">
                            {data.gameSession!.pfResults.length > 1 && (
                              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                                Roll #{i + 1}
                              </p>
                            )}
                            <div className="flex items-baseline gap-1.5">
                              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Ticket
                              </span>
                              <span className="text-2xl font-bold tabular-nums text-pink-600 dark:text-pink-400">
                                {pf.ticket.toLocaleString()}
                              </span>
                            </div>
                          </div>
                          {/* Card the ticket landed on. Only renders
                              when the PF row is linked to a kept
                              inventory item — i.e. the spin/draw was
                              a win and the user kept the card. */}
                          {pf.card && (
                            <div className="flex items-center gap-2 rounded-lg border bg-card p-1.5 sm:p-2">
                              <div className="aspect-[2/3] h-14 sm:h-16 overflow-hidden rounded bg-muted shrink-0">
                                <CardImage
                                  src={pf.card.imageUrl}
                                  alt={pf.card.name}
                                  className="size-full"
                                />
                              </div>
                              <div className="min-w-0 space-y-0.5">
                                <p
                                  className="text-xs font-medium truncate max-w-[180px]"
                                  title={pf.card.name}
                                >
                                  {pf.card.name}
                                </p>
                                {pf.card.rarity && (
                                  <span
                                    className={`inline-block rounded px-1 py-0.5 text-[10px] font-semibold leading-none ${
                                      RARITY_COLORS[
                                        pf.card.rarity.toLowerCase()
                                      ] ?? "bg-black/80 text-white"
                                    }`}
                                  >
                                    {pf.card.rarity}
                                  </span>
                                )}
                                <p className="text-[11px] font-medium tabular-nums text-rose-600 dark:text-rose-400">
                                  {formatCurrency(pf.card.valueAtObtained)}
                                </p>
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
                          <div className="min-w-0">
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              Client Seed
                            </p>
                            <p className="font-mono break-all">{pf.clientSeed}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              Server Seed Hash
                            </p>
                            <p className="font-mono break-all">
                              {pf.serverSeedHash}
                            </p>
                          </div>
                          {pf.serverSeed && (
                            <div className="col-span-2 min-w-0">
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Server Seed
                              </p>
                              <p className="font-mono break-all">
                                {pf.serverSeed}
                              </p>
                            </div>
                          )}
                          <div>
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              Nonce
                            </p>
                            <p className="font-mono">{pf.nonce}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              Cursor
                            </p>
                            <p className="font-mono">{pf.cursor}</p>
                          </div>
                          <div className="col-span-2 min-w-0">
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              Result Hash
                            </p>
                            <p className="font-mono break-all">{pf.resultHash}</p>
                          </div>
                          {/* result_metadata is per-game-type JSON
                              (upgrader carries target multiplier /
                              chance window, battles carry pool info,
                              packs carry pool weights). Surface the raw
                              blob for verification — admins can read
                              it directly without opening DevTools. */}
                          {pf.resultMetadata != null && (
                            <div className="col-span-2 min-w-0">
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Result Metadata
                              </p>
                              <pre className="font-mono text-[10px] leading-snug overflow-auto rounded bg-muted/60 p-2 max-h-32">
                                {JSON.stringify(pf.resultMetadata, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </FadeIn>
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
