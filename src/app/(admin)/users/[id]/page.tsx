import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getUserDetail, getUserTransactions, getUserAuditLog, getUserInventory, getUserPnlBreakdown, getUserRewards } from "@/lib/queries/users";
import { getNotesForUser } from "@/lib/queries/admin-notes";
import { requirePageAccess } from "@/lib/dal";
import { UserTabs } from "./user-tabs";

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePageAccess("/users");
  const { id } = await params;
  const sp = await searchParams;
  const txPage = Math.max(1, Number(sp.txPage) || 1);
  const txPerPage = [10, 20, 50, 100].includes(Number(sp.txPerPage))
    ? Number(sp.txPerPage)
    : 20;
  const auditPage = Math.max(1, Number(sp.auditPage) || 1);
  const auditPerPage = [10, 20, 50, 100].includes(Number(sp.auditPerPage))
    ? Number(sp.auditPerPage)
    : 20;

  const GAMING_TYPES = ["pack_opening", "battle_bet", "battle_sponsorship", "battle_refund"];
  const FINANCIAL_TYPES = ["deposit", "deposit_bonus", "admin_balance_adjustment", "card_withdrawal", "withdrawal_shipping_fee", "rakeback_claim", "balance_reward_claim", "affiliate_claim", "promo_code_redeemed", "gift_card_redeemed", "voucher_redeemed", "rain_win", "race_prize"];
  const CARD_SALE_TYPES = ["card_sale", "reward_card_sale"];
  const EXCHANGE_TYPES = ["card_exchange", "exchange_excess_to_voucher", "exchange_excess_credit", "battle_excess_to_voucher", "voucher_exchange"];

  const [data, transactions, auditLog, inventory, soldInventory, exchangedInventory, pnlBreakdown, notes, gamingTx, financialTx, rewards] = await Promise.all([
    getUserDetail(id),
    getUserTransactions(id, txPage, txPerPage, {
      type: typeof sp.txType === "string" ? sp.txType : undefined,
      status: typeof sp.txStatus === "string" ? sp.txStatus : undefined,
      dateFrom: typeof sp.txFrom === "string" ? sp.txFrom : undefined,
      dateTo: typeof sp.txTo === "string" ? sp.txTo : undefined,
    }),
    getUserAuditLog(id, auditPage, auditPerPage, {
      eventType: typeof sp.auditEventType === "string" ? sp.auditEventType : undefined,
    }),
    getUserInventory(id, 1, 24, { status: "owned" }),
    getUserInventory(id, 1, 24, { status: "sold" }),
    getUserInventory(id, 1, 24, { status: "exchanged" }),
    getUserPnlBreakdown(id),
    getNotesForUser(id),
    getUserTransactions(id, 1, 10, { types: GAMING_TYPES }),
    getUserTransactions(id, 1, 10, { types: FINANCIAL_TYPES }),
    getUserRewards(id),
  ]);

  if (!data) notFound();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/users" className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground">
          <ArrowLeft className="size-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">
            {data.user.username ?? data.user.email}
          </h1>
          <p className="text-sm text-muted-foreground">{data.user.email}</p>
        </div>
      </div>
      <UserTabs data={{ ...data, sessionRole: session.role }} transactions={transactions} auditLog={auditLog} inventory={inventory} soldInventory={soldInventory} exchangedInventory={exchangedInventory} pnlBreakdown={pnlBreakdown} notes={notes} gamingTx={gamingTx} financialTx={financialTx} rewards={rewards} />
    </div>
  );
}
