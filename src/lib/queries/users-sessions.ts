import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

export type UserSession = {
  id: number;
  depositAmount: number;
  depositDate: string;
  depositCryptoAsset: string | null;
  withdrawAmount: number | null;
  withdrawDate: string | null;
  withdrawMethod: string | null;
  withdrawStatus: string | null;
  activityCount: number;
  wagered: number;
  won: number;
  netPnl: number;
  endBalance: number;
  isOpen: boolean;
};

export async function getUserSessions(userId: string): Promise<UserSession[]> {
  // Fetch all completed transactions ordered by time
  const transactions = await db.ledger_transactions.findMany({
    where: { user_id: userId, status: "completed" },
    orderBy: { created_at: "asc" },
    select: {
      type: true,
      amount: true,
      balance_after: true,
      created_at: true,
    },
  });

  // Fetch all crypto withdrawal requests
  const cryptoWithdrawals = await db.card_withdrawal_requests.findMany({
    where: { user_id: userId, method: "crypto" },
    orderBy: { requested_at: "asc" },
    select: {
      total_value_usd: true,
      status: true,
      requested_at: true,
    },
  });

  // Build a merged timeline of events
  type TimelineEvent =
    | { kind: "deposit"; amount: number; balance: number; date: Date }
    | { kind: "crypto_withdrawal"; amount: number; status: string; date: Date }
    | { kind: "activity"; type: string; amount: number; balance: number; date: Date };

  const timeline: TimelineEvent[] = [];

  const wagerTypes = new Set(["pack_opening", "battle_bet", "battle_sponsorship"]);
  const winTypes = new Set(["card_sale", "reward_card_sale", "race_prize", "rain_win", "balance_reward_claim"]);

  for (const t of transactions) {
    const amt = toNumber(t.amount);
    const bal = toNumber(t.balance_after);
    const date = t.created_at;

    if (t.type === "deposit") {
      timeline.push({ kind: "deposit", amount: amt, balance: bal, date });
    } else {
      timeline.push({ kind: "activity", type: t.type, amount: amt, balance: bal, date });
    }
  }

  for (const w of cryptoWithdrawals) {
    timeline.push({
      kind: "crypto_withdrawal",
      amount: toNumber(w.total_value_usd),
      status: w.status,
      date: w.requested_at,
    });
  }

  // Sort by date
  timeline.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Build sessions: each deposit starts a new session, each crypto withdrawal ends it
  type SessionState = {
    depositAmount: number;
    depositDate: Date;
    depositCryptoAsset: null;
    wagered: number;
    won: number;
    activityCount: number;
    endBalance: number;
  };
  const sessions: UserSession[] = [];
  let current: SessionState | null = null;
  let sessionId = 0;

  const startNewSession = (date: Date, balance: number, depositAmount: number = 0) => {
    sessionId++;
    current = {
      depositAmount,
      depositDate: date,
      depositCryptoAsset: null,
      wagered: 0,
      won: 0,
      activityCount: 0,
      endBalance: balance,
    };
  };

  const closeSession = (withdrawAmount: number | null = null, withdrawDate: Date | null = null, withdrawMethod: string | null = null, withdrawStatus: string | null = null) => {
    if (!current) return;
    sessions.push({
      id: sessionId,
      depositAmount: current.depositAmount,
      depositDate: current.depositDate.toISOString(),
      depositCryptoAsset: null,
      withdrawAmount,
      withdrawDate: withdrawDate?.toISOString() ?? null,
      withdrawMethod,
      withdrawStatus,
      activityCount: current.activityCount,
      wagered: current.wagered,
      won: current.won,
      netPnl: current.won - current.wagered,
      endBalance: current.endBalance,
      isOpen: withdrawAmount === null,
    });
  };

  for (const event of timeline) {
    if (event.kind === "deposit") {
      // Close any open session before starting a new one
      if (current) {
        closeSession();
      }
      startNewSession(event.date, event.balance, event.amount);
    } else if (event.kind === "crypto_withdrawal") {
      if (current) {
        closeSession(event.amount, event.date, "crypto", event.status);
        current = null;
      }
    } else if (event.kind === "activity") {
      // Start a session if none is open
      if (!current) {
        startNewSession(event.date, event.balance);
      }
      current!.activityCount++;
      current!.endBalance = event.balance;
      if (wagerTypes.has(event.type)) {
        current!.wagered += Math.abs(event.amount);
      }
      if (winTypes.has(event.type)) {
        current!.won += event.amount;
      }
    }
  }

  // Close last open session if any
  const last = current as SessionState | null;
  if (last) {
    sessions.push({
      id: sessionId,
      depositAmount: last.depositAmount,
      depositDate: last.depositDate.toISOString(),
      depositCryptoAsset: null,
      withdrawAmount: null,
      withdrawDate: null,
      withdrawMethod: null,
      withdrawStatus: null,
      activityCount: last.activityCount,
      wagered: last.wagered,
      won: last.won,
      netPnl: last.won - last.wagered,
      endBalance: last.endBalance,
      isOpen: true,
    });
  }

  // Return newest first
  return sessions.reverse();
}
