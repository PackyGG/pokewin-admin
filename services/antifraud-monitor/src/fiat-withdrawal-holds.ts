import type pg from "pg";

const UTC = "AT TIME ZONE 'UTC'";
const HOLD_CURSOR_MILLISECONDS =
  "date_trunc('milliseconds', fl.locked_withdrawals_at)";

export const FIAT_WITHDRAWAL_HOLD_EVENT =
  "fiat_deposit_withdrawal_hold" as const;
export const FIAT_WITHDRAWAL_HOLD_SCORE = 80;
export const FIAT_WITHDRAWAL_HOLD_STREAM = "fiat-withdrawal-holds";

export type FiatWithdrawalHold = {
  user_id: string;
  username: string | null;
  source_created_at: Date;
  locked_at: Date;
  reason: string;
  locked_withdrawals_crypto: string[];
  locked_withdrawals_items: boolean;
};

export async function fetchFiatWithdrawalHolds(
  source: pg.Pool,
  cursor: { occurredAt: Date; sourceId: string },
  limit = 100,
): Promise<FiatWithdrawalHold[]> {
  const result = await source.query<FiatWithdrawalHold>(
    `
      SELECT
        fl.user_id,
        COALESCE(u.display_username, u.username) AS username,
        u.created_at ${UTC} AS source_created_at,
        ${HOLD_CURSOR_MILLISECONDS} ${UTC} AS locked_at,
        fl.locked_withdrawals_reason AS reason,
        fl.locked_withdrawals_crypto,
        fl.locked_withdrawals_items
      FROM user_feature_locks fl
      JOIN "user" u ON u.id = fl.user_id
      WHERE (${HOLD_CURSOR_MILLISECONDS}, fl.user_id) >
        (date_trunc('milliseconds', $1::timestamptz ${UTC}), $2::text)
        AND fl.locked_withdrawals_at <= (now() ${UTC}) - interval '1 second'
        AND fl.locked_withdrawals_reason LIKE 'Lifetime deposits reached $%'
        AND 'all' = ANY(fl.locked_withdrawals_crypto)
        AND fl.locked_withdrawals_items = true
      ORDER BY ${HOLD_CURSOR_MILLISECONDS}, fl.user_id
      LIMIT $3
    `,
    [cursor.occurredAt, cursor.sourceId, limit],
  );
  return result.rows;
}

export function fiatWithdrawalHoldSourceRef(
  hold: Pick<FiatWithdrawalHold, "user_id" | "locked_at">,
): string {
  return `${hold.user_id}:${hold.locked_at.toISOString()}`;
}

export function fiatWithdrawalHoldMarker(hold: FiatWithdrawalHold): {
  eventType: typeof FIAT_WITHDRAWAL_HOLD_EVENT;
  source: "fiat_withdrawal_hold";
  sourceRef: string;
  score: typeof FIAT_WITHDRAWAL_HOLD_SCORE;
  title: string;
  detail: string;
  payload: {
    automatic: true;
    lockedWithdrawalsCrypto: string[];
    lockedWithdrawalsItems: boolean;
    lockedWithdrawalsReason: string;
  };
} {
  return {
    eventType: FIAT_WITHDRAWAL_HOLD_EVENT,
    source: "fiat_withdrawal_hold",
    sourceRef: fiatWithdrawalHoldSourceRef(hold),
    score: FIAT_WITHDRAWAL_HOLD_SCORE,
    title: "Fiat-triggered withdrawal hold",
    detail:
      "Lifetime fiat deposits crossed the automatic review threshold; crypto withdrawals and item shipping are locked.",
    payload: {
      automatic: true,
      lockedWithdrawalsCrypto: hold.locked_withdrawals_crypto,
      lockedWithdrawalsItems: hold.locked_withdrawals_items,
      lockedWithdrawalsReason: hold.reason,
    },
  };
}
