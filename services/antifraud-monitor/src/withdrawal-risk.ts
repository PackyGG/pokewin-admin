import type { Pool } from "pg";

import type { Databases } from "./db.js";

export type WithdrawalVerdict = "good" | "review" | "bad";

export type WithdrawalSignal = {
  key: string;
  label: string;
  detail: string;
  points: number;
  tone: "good" | "neutral" | "warning" | "bad";
  category: WithdrawalRiskCategory;
};

export type WithdrawalRiskCategory =
  "integrity" | "funding" | "behavior" | "account" | "network";

export type WithdrawalScoreBreakdown = Record<WithdrawalRiskCategory, number>;

export type WithdrawalFlowCheck = {
  key: WithdrawalRiskCategory;
  label: string;
  description: string;
  status: "pass" | "review" | "block";
  score: number;
  evidence: string[];
};

export type WithdrawalTimelineEvent = {
  id: string;
  type: string;
  label: string;
  detail: string | null;
  amountUsd: number;
  occurredAt: string;
  category: "deposit" | "play" | "win" | "reward" | "withdrawal" | "account";
  tone: "good" | "neutral" | "warning" | "bad";
  isOrigin: boolean;
};

export type WithdrawalSource = {
  key: string;
  label: string;
  count: number;
  valueUsd: number;
  traceable: boolean;
};

export type WithdrawalFlow = {
  originType: string | null;
  originLabel: string;
  originAt: string | null;
  originAmountUsd: number;
  depositsUsd: number;
  gameWinsUsd: number;
  gameLossesUsd: number;
  rewardsUsd: number;
  withdrawalUsd: number;
  gameEvents: number;
  minutesSinceLastDeposit: number | null;
  accountAgeDays: number;
  tracedAssetUsd: number;
  untracedAssetUsd: number;
};

export type WithdrawalScoreInput = {
  method: string;
  amountUsd: number;
  assetValueUsd: number;
  tracedAssetUsd: number;
  assetCount: number;
  depositsUsd: number;
  gameWinsUsd: number;
  gameLossesUsd: number;
  rewardsUsd: number;
  gameEvents: number;
  minutesSinceLastDeposit: number | null;
  accountAgeDays: number;
  otherUsersAtDestination: number;
};

export function scoreWithdrawal(input: WithdrawalScoreInput): {
  riskScore: number;
  verdict: WithdrawalVerdict;
  summary: string;
  signals: WithdrawalSignal[];
  scoreBreakdown: WithdrawalScoreBreakdown;
  flowChecks: WithdrawalFlowCheck[];
} {
  const signals: WithdrawalSignal[] = [];
  const amount = Math.max(0, input.amountUsd);
  const usesAttachedAssets = input.method !== "balance";

  if (!usesAttachedAssets) {
    signals.push({
      key: "balance_withdrawal",
      label: "Balance withdrawal",
      detail:
        "This payout comes from account balance, so card or voucher attachments are not expected.",
      points: 0,
      tone: "good",
      category: "integrity",
    });
  } else {
    const difference = Math.abs(input.assetValueUsd - amount);
    const differenceRatio =
      amount > 0 ? difference / amount : difference > 0 ? 1 : 0;
    const tracedRatio =
      input.assetValueUsd > 0 ? input.tracedAssetUsd / input.assetValueUsd : 0;

    if (difference <= Math.max(1, amount * 0.02)) {
      signals.push({
        key: "amount_reconciled",
        label: "Amount reconciles",
        detail:
          "The attached cards and vouchers reconcile with the requested value.",
        points: 0,
        tone: "good",
        category: "integrity",
      });
    } else {
      signals.push({
        key: "amount_mismatch",
        label: "Amount mismatch",
        detail: `$${difference.toFixed(2)} of the request is not explained by its attached assets.`,
        points: differenceRatio > 0.1 ? 45 : 25,
        tone: differenceRatio > 0.1 ? "bad" : "warning",
        category: "integrity",
      });
    }

    if (input.assetCount === 0) {
      signals.push({
        key: "no_assets",
        label: "No attached assets",
        detail: "The withdrawal has no card or voucher records to trace.",
        points: 35,
        tone: "bad",
        category: "integrity",
      });
    } else if (tracedRatio >= 0.9) {
      signals.push({
        key: "source_traced",
        label: "Source traced",
        detail: `${Math.round(tracedRatio * 100)}% of the attached value has a known origin.`,
        points: 0,
        tone: "good",
        category: "integrity",
      });
    } else {
      signals.push({
        key: "source_gap",
        label: "Source gap",
        detail: `${Math.round((1 - tracedRatio) * 100)}% of the attached value has no dependable origin.`,
        points: tracedRatio < 0.5 ? 35 : 18,
        tone: tracedRatio < 0.5 ? "bad" : "warning",
        category: "integrity",
      });
    }
  }

  if (
    input.minutesSinceLastDeposit !== null &&
    input.minutesSinceLastDeposit >= 0 &&
    input.minutesSinceLastDeposit < 60 &&
    input.gameEvents < 2
  ) {
    signals.push({
      key: "rapid_cashout",
      label: "Rapid cash-out",
      detail:
        "A deposit was followed by this withdrawal within one hour with little play.",
      points: 35,
      tone: "bad",
      category: "behavior",
    });
  }

  if (amount >= 50 && input.gameEvents === 0) {
    signals.push({
      key: "no_gameplay",
      label: "No gameplay trail",
      detail:
        "No qualifying game activity was found between the funding origin and this withdrawal.",
      points: 20,
      tone: "warning",
      category: "behavior",
    });
  }

  const explainedFunding =
    input.depositsUsd + input.gameWinsUsd + input.rewardsUsd;
  if (amount >= 50 && explainedFunding + 1 < amount) {
    signals.push({
      key: "funding_gap",
      label: "Funding gap",
      detail: `$${Math.max(0, amount - explainedFunding).toFixed(2)} is not covered by deposits, wins, or rewards in this withdrawal's funding trail.`,
      points: 25,
      tone: "warning",
      category: "funding",
    });
  }

  if (
    amount >= 50 &&
    input.rewardsUsd > 0 &&
    input.rewardsUsd / Math.max(explainedFunding, 1) >= 0.5
  ) {
    signals.push({
      key: "reward_funded",
      label: "Mostly reward-funded",
      detail:
        "At least half of the recent incoming value came from rewards or promotions.",
      points: 18,
      tone: "warning",
      category: "funding",
    });
  }

  if (input.accountAgeDays < 1) {
    signals.push({
      key: "new_account",
      label: "New account",
      detail: "The account is less than one day old.",
      points: 25,
      tone: "bad",
      category: "account",
    });
  } else if (input.accountAgeDays < 7) {
    signals.push({
      key: "young_account",
      label: "Young account",
      detail: "The account is less than seven days old.",
      points: 10,
      tone: "warning",
      category: "account",
    });
  }

  if (input.otherUsersAtDestination > 0) {
    signals.push({
      key: "shared_destination",
      label: "Shared destination",
      detail: `The same payout destination appears on ${input.otherUsersAtDestination} other account${input.otherUsersAtDestination === 1 ? "" : "s"}.`,
      points: Math.min(70, 50 + input.otherUsersAtDestination * 10),
      tone: "bad",
      category: "network",
    });
  }

  const riskScore = Math.min(
    100,
    signals.reduce((total, signal) => total + signal.points, 0),
  );
  const verdict: WithdrawalVerdict =
    riskScore >= 60 ? "bad" : riskScore >= 30 ? "review" : "good";
  const primary = [...signals]
    .filter((signal) => signal.points > 0)
    .sort((a, b) => b.points - a.points)[0];
  const summary =
    primary?.detail ??
    (usesAttachedAssets
      ? "The amount, attached assets, funding trail, and account checks reconcile."
      : "The balance funding trail and account checks did not raise a risk signal.");
  const scoreBreakdown: WithdrawalScoreBreakdown = {
    integrity: 0,
    funding: 0,
    behavior: 0,
    account: 0,
    network: 0,
  };
  for (const signal of signals) {
    scoreBreakdown[signal.category] = Math.min(
      100,
      scoreBreakdown[signal.category] + signal.points,
    );
  }
  const definitions: {
    key: WithdrawalRiskCategory;
    label: string;
    description: string;
  }[] = [
    {
      key: "integrity",
      label: "Request integrity",
      description: usesAttachedAssets
        ? "Reconcile the requested amount and every attached asset."
        : "Confirm that this is a balance payout with no asset attachment required.",
    },
    {
      key: "funding",
      label: "Funding source",
      description: "Explain the payout through deposits, wins, and rewards.",
    },
    {
      key: "behavior",
      label: "Play behavior",
      description: "Check play-through, velocity, and rapid cash-out behavior.",
    },
    {
      key: "account",
      label: "Account trust",
      description: "Evaluate account maturity and other trust context.",
    },
    {
      key: "network",
      label: "Payout destination",
      description: "Look for destinations reused across player accounts.",
    },
  ];
  const flowChecks: WithdrawalFlowCheck[] = definitions.map((definition) => {
    const categorySignals = signals.filter(
      (signal) => signal.category === definition.key,
    );
    const score = scoreBreakdown[definition.key];
    return {
      ...definition,
      status: score >= 40 ? "block" : score > 0 ? "review" : "pass",
      score,
      evidence:
        categorySignals.length > 0
          ? categorySignals.map((signal) => signal.detail)
          : ["No risk signal triggered for this check."],
    };
  });
  return {
    riskScore,
    verdict,
    summary,
    signals,
    scoreBreakdown,
    flowChecks,
  };
}

type SourceWithdrawal = {
  id: string;
  user_id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  account_created_at: string;
  method: string;
  status: string;
  inventory_item_ids: string[];
  voucher_ids: string[];
  total_value_usd: string;
  destination_address: string | null;
  requested_at: string;
  updated_at: string;
};

type LedgerContext = {
  withdrawal_id: string;
  origin_type: string | null;
  origin_at: string | null;
  origin_amount_usd: string;
  deposits_usd: string;
  game_losses_usd: string;
  game_wins_usd: string;
  rewards_usd: string;
  game_events: number;
  last_deposit_at: string | null;
};

type AssetRow = {
  id: string;
  source_type: string;
  value_usd: string;
};

const GAME_LOSS_TYPES = [
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "keno_bet",
  "upgrader_bet",
];
const GAME_WIN_TYPES = [
  "battle_refund",
  "battle_excess_to_voucher",
  "keno_payout",
  "upgrader_payout",
];
const REWARD_TYPES = [
  "deposit_bonus",
  "rakeback_claim",
  "gift_card_redeemed",
  "promo_code_redeemed",
  "race_prize",
  "rain_win",
  "waitlist_prize",
  "balance_reward_claim",
  "affiliate_claim",
  "affiliate_leaderboard_prize",
  "challenge_prize",
];
const OTHER_FUNDING_SOURCE_TYPES = [
  ...REWARD_TYPES,
  ...GAME_WIN_TYPES,
  "admin_balance_adjustment",
  "card_sale",
  "reward_card_sale",
  "exchange_excess_credit",
  "voucher_redeemed",
];

function fundingSourceLabel(type: string | null): string {
  if (!type) return "No funding origin found";
  if (type === "deposit") return "Latest deposit";
  const labels: Record<string, string> = {
    admin_balance_adjustment: "Admin balance credit",
    card_sale: "Card sale",
    reward_card_sale: "Reward card sale",
    exchange_excess_credit: "Exchange credit",
    voucher_redeemed: "Voucher redemption",
  };
  return labels[type] ?? type.replaceAll("_", " ");
}

function timelineCategory(type: string): {
  category: WithdrawalTimelineEvent["category"];
  tone: WithdrawalTimelineEvent["tone"];
  label: string;
} {
  if (type === "deposit") {
    return { category: "deposit", tone: "good", label: "Deposit completed" };
  }
  if (GAME_LOSS_TYPES.includes(type)) {
    return {
      category: "play",
      tone: "good",
      label: type.replaceAll("_", " "),
    };
  }
  if (GAME_WIN_TYPES.includes(type)) {
    return {
      category: "win",
      tone: "bad",
      label: type.replaceAll("_", " "),
    };
  }
  if (REWARD_TYPES.includes(type)) {
    return {
      category: "reward",
      tone: "bad",
      label: type.replaceAll("_", " "),
    };
  }
  return {
    category: "account",
    tone: "neutral",
    label: type.replaceAll("_", " "),
  };
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    pack: "Pack opening wins",
    battle: "Battle wins",
    upgrader: "Upgrader wins",
    reward: "Rewards",
    raffle: "Raffle prizes",
    exchange: "Exchanged assets",
    voucher_battle: "Battle vouchers",
    voucher_upgrader: "Upgrader vouchers",
    voucher_pack_borrow: "Borrow-mode pack vouchers",
    voucher_exchange: "Exchange vouchers",
    voucher_creator: "Creator-program vouchers",
    voucher_unknown: "Other vouchers",
  };
  return labels[source] ?? source.replaceAll("_", " ");
}

function buildSources(
  request: SourceWithdrawal,
  inventoryById: Map<string, AssetRow>,
  voucherById: Map<string, AssetRow>,
): WithdrawalSource[] {
  const grouped = new Map<string, WithdrawalSource>();
  const add = (row: AssetRow | undefined, fallback: string) => {
    const key = row?.source_type || fallback;
    const valueUsd = number(row?.value_usd);
    const traceable = Boolean(
      row?.source_type && !row.source_type.includes("unknown"),
    );
    const existing = grouped.get(key) ?? {
      key,
      label: sourceLabel(key),
      count: 0,
      valueUsd: 0,
      traceable,
    };
    existing.count += 1;
    existing.valueUsd += valueUsd;
    existing.traceable = existing.traceable && traceable;
    grouped.set(key, existing);
  };
  request.inventory_item_ids.forEach((id) =>
    add(inventoryById.get(id), "unknown_card"),
  );
  request.voucher_ids.forEach((id) =>
    add(voucherById.get(id), "unknown_voucher"),
  );
  return [...grouped.values()]
    .map((source) => ({
      ...source,
      valueUsd: Number(source.valueUsd.toFixed(2)),
    }))
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

async function loadLedgerContext(
  source: Pool,
  withdrawals: SourceWithdrawal[],
): Promise<Map<string, LedgerContext>> {
  if (withdrawals.length === 0) return new Map();
  const ids = withdrawals.map((row) => row.id);
  const userIds = withdrawals.map((row) => row.user_id);
  const requestedAt = withdrawals.map((row) => row.requested_at);
  const result = await source.query<LedgerContext>(
    `
      WITH targets AS (
        SELECT *
        FROM unnest($1::uuid[], $2::text[], $3::timestamptz[])
          AS t(withdrawal_id, user_id, requested_at)
      ),
      origins AS (
        SELECT
          t.*,
          COALESCE(latest_deposit.type, latest_other.type) AS origin_type,
          COALESCE(latest_deposit.created_at, latest_other.created_at)
            AS origin_at,
          COALESCE(latest_deposit.amount_usd, latest_other.amount_usd, 0)
            AS origin_amount_usd
        FROM targets t
        LEFT JOIN LATERAL (
          SELECT
            lt.type::text AS type,
            lt.created_at,
            ABS(lt.amount::numeric) AS amount_usd
          FROM ledger_transactions lt
          WHERE lt.user_id=t.user_id
            AND lt.status::text='completed'
            AND lt.type::text='deposit'
            AND lt.created_at<=t.requested_at
          ORDER BY lt.created_at DESC, lt.id DESC
          LIMIT 1
        ) latest_deposit ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            lt.type::text AS type,
            lt.created_at,
            ABS(lt.amount::numeric) AS amount_usd
          FROM ledger_transactions lt
          WHERE latest_deposit.created_at IS NULL
            AND lt.user_id=t.user_id
            AND lt.status::text='completed'
            AND lt.type::text=ANY($7::text[])
            AND lt.created_at<=t.requested_at
          ORDER BY lt.created_at DESC, lt.id DESC
          LIMIT 1
        ) latest_other ON TRUE
      )
      SELECT
        o.withdrawal_id,
        o.origin_type,
        o.origin_at,
        o.origin_amount_usd::text,
        COALESCE(SUM(ABS(lt.amount::numeric))
          FILTER (WHERE lt.type::text='deposit'), 0)::text AS deposits_usd,
        COALESCE(SUM(ABS(lt.amount::numeric))
          FILTER (WHERE lt.type::text=ANY($4::text[])), 0)::text AS game_losses_usd,
        COALESCE(SUM(ABS(lt.amount::numeric))
          FILTER (WHERE lt.type::text=ANY($5::text[])), 0)::text AS game_wins_usd,
        COALESCE(SUM(ABS(lt.amount::numeric))
          FILTER (WHERE lt.type::text=ANY($6::text[])), 0)::text AS rewards_usd,
        COUNT(lt.id) FILTER (
          WHERE lt.type::text=ANY($4::text[]) OR lt.type::text=ANY($5::text[])
        )::int AS game_events,
        MAX(lt.created_at) FILTER (WHERE lt.type::text='deposit') AS last_deposit_at
      FROM origins o
      LEFT JOIN ledger_transactions lt
        ON o.origin_at IS NOT NULL
       AND lt.user_id=o.user_id
       AND lt.status::text='completed'
       AND lt.created_at>=o.origin_at
       AND lt.created_at<=o.requested_at
       AND (
         lt.type::text='deposit'
         OR lt.type::text=ANY($4::text[])
         OR lt.type::text=ANY($5::text[])
         OR lt.type::text=ANY($6::text[])
       )
      GROUP BY
        o.withdrawal_id,
        o.origin_type,
        o.origin_at,
        o.origin_amount_usd
    `,
    [
      ids,
      userIds,
      requestedAt,
      GAME_LOSS_TYPES,
      GAME_WIN_TYPES,
      REWARD_TYPES,
      OTHER_FUNDING_SOURCE_TYPES,
    ],
  );
  return new Map(result.rows.map((row) => [row.withdrawal_id, row]));
}

async function loadAssets(
  source: Pool,
  withdrawals: SourceWithdrawal[],
): Promise<{
  inventory: Map<string, AssetRow>;
  vouchers: Map<string, AssetRow>;
}> {
  const inventoryIds = withdrawals.flatMap((row) => row.inventory_item_ids);
  const voucherIds = withdrawals.flatMap((row) => row.voucher_ids);
  const [inventory, vouchers] = await Promise.all([
    inventoryIds.length
      ? source.query<AssetRow>(
          `SELECT id::text, source_type::text,
                  value_at_obtained::text AS value_usd
             FROM user_inventory
            WHERE id=ANY($1::uuid[])`,
          [inventoryIds],
        )
      : { rows: [] as AssetRow[] },
    voucherIds.length
      ? source.query<AssetRow>(
          `SELECT id::text,
                  CASE origin::text
                    WHEN 'battle_excess_to_voucher' THEN 'voucher_battle'
                    WHEN 'battle_double_down_payout' THEN 'voucher_battle'
                    WHEN 'upgrader_excess_to_voucher' THEN 'voucher_upgrader'
                    WHEN 'pack_borrow_to_voucher' THEN 'voucher_pack_borrow'
                    WHEN 'exchange_excess_to_voucher' THEN 'voucher_exchange'
                    WHEN 'creator_fill_conversion' THEN 'voucher_creator'
                    WHEN 'creator_multiplier_payout' THEN 'voucher_creator'
                    ELSE 'voucher_unknown'
                  END AS source_type,
                  value::text AS value_usd
             FROM vouchers
            WHERE id=ANY($1::uuid[])`,
          [voucherIds],
        )
      : { rows: [] as AssetRow[] },
  ]);
  return {
    inventory: new Map(inventory.rows.map((row) => [row.id, row])),
    vouchers: new Map(vouchers.rows.map((row) => [row.id, row])),
  };
}

async function destinationReuse(
  source: Pool,
  withdrawals: SourceWithdrawal[],
): Promise<Map<string, number>> {
  const addresses = withdrawals
    .map((row) => row.destination_address)
    .filter((value): value is string => Boolean(value));
  if (addresses.length === 0) return new Map();
  const result = await source.query<{
    destination_address: string;
    users: number;
  }>(
    `
      SELECT destination_address, COUNT(DISTINCT user_id)::int AS users
      FROM card_withdrawal_requests
      WHERE destination_address=ANY($1::text[])
      GROUP BY destination_address
    `,
    [addresses],
  );
  return new Map(
    result.rows.map((row) => [
      row.destination_address,
      Math.max(0, row.users - 1),
    ]),
  );
}

export class WithdrawalRiskService {
  constructor(private readonly db: Databases) {}

  async loadTimeline(input: {
    withdrawalId: string;
    userId: string;
    requestedAt: string;
    amountUsd: number;
  }): Promise<WithdrawalTimelineEvent[]> {
    const originResult = await this.db.source.query<{
      id: string;
      type: string;
      amount_usd: string;
      description: string | null;
      created_at: string;
    }>(
      `
        WITH latest_deposit AS (
          SELECT id, type::text, ABS(amount::numeric)::text AS amount_usd,
                 description, created_at
          FROM ledger_transactions
          WHERE user_id=$1
            AND status::text='completed'
            AND type::text='deposit'
            AND created_at<=$2::timestamptz
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ),
        latest_other AS (
          SELECT id, type::text, ABS(amount::numeric)::text AS amount_usd,
                 description, created_at
          FROM ledger_transactions
          WHERE user_id=$1
            AND status::text='completed'
            AND type::text=ANY($3::text[])
            AND created_at<=$2::timestamptz
            AND NOT EXISTS (SELECT 1 FROM latest_deposit)
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        )
        SELECT id::text, type, amount_usd, description, created_at
        FROM latest_deposit
        UNION ALL
        SELECT id::text, type, amount_usd, description, created_at
        FROM latest_other
        LIMIT 1
      `,
      [input.userId, input.requestedAt, OTHER_FUNDING_SOURCE_TYPES],
    );
    const origin = originResult.rows[0];
    if (!origin) {
      return [
        {
          id: `withdrawal:${input.withdrawalId}`,
          type: "withdrawal_requested",
          label: "Withdrawal requested",
          detail:
            "No completed funding origin could be linked to this request.",
          amountUsd: input.amountUsd,
          occurredAt: input.requestedAt,
          category: "withdrawal",
          tone: "bad",
          isOrigin: false,
        },
      ];
    }
    const result = await this.db.source.query<{
      id: string;
      type: string;
      amount_usd: string;
      description: string | null;
      created_at: string;
    }>(
      `
        SELECT id::text, type::text, ABS(amount::numeric)::text AS amount_usd,
               description, created_at
        FROM ledger_transactions
        WHERE user_id=$1
          AND status::text='completed'
          AND created_at >= $2::timestamptz
          AND created_at <= $3::timestamptz
        ORDER BY created_at DESC, id DESC
        LIMIT 148
      `,
      [input.userId, origin.created_at, input.requestedAt],
    );
    const ledgerEvents = result.rows.reverse().map((row) => {
      const display = timelineCategory(row.type);
      return {
        id: row.id,
        type: row.type,
        label:
          row.id === origin.id
            ? `Funding origin: ${fundingSourceLabel(row.type)}`
            : display.label,
        detail:
          row.id === origin.id
            ? "This is the starting source used for the current withdrawal trail."
            : row.description,
        amountUsd: number(row.amount_usd),
        occurredAt: new Date(row.created_at).toISOString(),
        category: display.category,
        tone: display.tone,
        isOrigin: row.id === origin.id,
      };
    });
    if (!ledgerEvents.some((event) => event.isOrigin)) {
      const display = timelineCategory(origin.type);
      ledgerEvents.unshift({
        id: origin.id,
        type: origin.type,
        label: `Funding origin: ${fundingSourceLabel(origin.type)}`,
        detail:
          "This is the starting source used for the current withdrawal trail.",
        amountUsd: number(origin.amount_usd),
        occurredAt: new Date(origin.created_at).toISOString(),
        category: display.category,
        tone: display.tone,
        isOrigin: true,
      });
    }
    return [
      ...ledgerEvents,
      {
        id: `withdrawal:${input.withdrawalId}`,
        type: "withdrawal_requested",
        label: "Withdrawal requested",
        detail: "This request entered the fraud review flow.",
        amountUsd: input.amountUsd,
        occurredAt: input.requestedAt,
        category: "withdrawal",
        tone: "bad",
        isOrigin: false,
      },
    ];
  }

  async refreshPage(input: {
    page: number;
    limit: number;
    status?: string;
    search?: string;
    excludedUserIds?: string[];
  }): Promise<{ ids: string[]; total: number }> {
    const offset = (input.page - 1) * input.limit;
    const values: unknown[] = [];
    const conditions: string[] = [
      `COALESCE(u.role::text,'')<>'creator'`,
      `'creator'<>ALL(COALESCE(u.roles::text[], ARRAY[]::text[]))`,
    ];
    if (input.excludedUserIds?.length) {
      values.push(input.excludedUserIds);
      conditions.push(`cwr.user_id<>ALL($${values.length}::text[])`);
    }
    if (input.status) {
      values.push(input.status);
      conditions.push(`cwr.status::text=$${values.length}`);
    }
    if (input.search) {
      values.push(`%${input.search.toLowerCase()}%`);
      conditions.push(`(
        lower(cwr.user_id) LIKE $${values.length}
        OR lower(COALESCE(u.username,'')) LIKE $${values.length}
        OR lower(COALESCE(u.email,'')) LIKE $${values.length}
      )`);
    }
    values.push(input.limit, offset);
    const [requests, total] = await Promise.all([
      this.db.source.query<SourceWithdrawal>(
        `
        SELECT
          cwr.id::text, cwr.user_id, u.username, u.email, u.image,
          u.created_at AS account_created_at,
          cwr.method::text, cwr.status::text,
          cwr.inventory_item_ids::text[], cwr.voucher_ids::text[],
          cwr.total_value_usd::text, cwr.destination_address,
          cwr.requested_at, cwr.updated_at
        FROM card_withdrawal_requests cwr
        JOIN "user" u ON u.id=cwr.user_id
        ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY cwr.requested_at DESC, cwr.id DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}
      `,
        values,
      ),
      this.db.source.query<{ count: number }>(
        `
          SELECT COUNT(*)::int AS count
          FROM card_withdrawal_requests cwr
          JOIN "user" u ON u.id=cwr.user_id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        `,
        values.slice(0, -2),
      ),
    ]);
    if (requests.rows.length === 0) {
      return { ids: [], total: total.rows[0]?.count ?? 0 };
    }

    const [ledgerById, assets, reuseByAddress] = await Promise.all([
      loadLedgerContext(this.db.source, requests.rows),
      loadAssets(this.db.source, requests.rows),
      destinationReuse(this.db.source, requests.rows),
    ]);

    const assessments = requests.rows.map((request) => {
      const sources = buildSources(request, assets.inventory, assets.vouchers);
      const ledger = ledgerById.get(request.id);
      const amountUsd = number(request.total_value_usd);
      const assetValueUsd = sources.reduce(
        (sum, source) => sum + source.valueUsd,
        0,
      );
      const tracedAssetUsd = sources
        .filter((source) => source.traceable)
        .reduce((sum, source) => sum + source.valueUsd, 0);
      const requestedAt = new Date(request.requested_at);
      const createdAt = new Date(request.account_created_at);
      const lastDepositAt = ledger?.last_deposit_at
        ? new Date(ledger.last_deposit_at)
        : null;
      const flow: WithdrawalFlow = {
        originType: ledger?.origin_type ?? null,
        originLabel: fundingSourceLabel(ledger?.origin_type ?? null),
        originAt: ledger?.origin_at
          ? new Date(ledger.origin_at).toISOString()
          : null,
        originAmountUsd: number(ledger?.origin_amount_usd),
        depositsUsd: number(ledger?.deposits_usd),
        gameWinsUsd:
          number(ledger?.game_wins_usd) +
          sources
            .filter((source) =>
              [
                "pack",
                "battle",
                "upgrader",
                "voucher_battle",
                "voucher_upgrader",
              ].includes(source.key),
            )
            .reduce((sum, source) => sum + source.valueUsd, 0),
        gameLossesUsd: number(ledger?.game_losses_usd),
        rewardsUsd:
          number(ledger?.rewards_usd) +
          sources
            .filter((source) =>
              ["reward", "raffle", "voucher_creator"].includes(source.key),
            )
            .reduce((sum, source) => sum + source.valueUsd, 0),
        withdrawalUsd: amountUsd,
        gameEvents: number(ledger?.game_events),
        minutesSinceLastDeposit: lastDepositAt
          ? Math.max(
              0,
              (requestedAt.getTime() - lastDepositAt.getTime()) / 60_000,
            )
          : null,
        accountAgeDays: Math.max(
          0,
          (requestedAt.getTime() - createdAt.getTime()) / 86_400_000,
        ),
        tracedAssetUsd,
        untracedAssetUsd: Math.max(0, assetValueUsd - tracedAssetUsd),
      };
      const scored = scoreWithdrawal({
        method: request.method,
        amountUsd,
        assetValueUsd,
        tracedAssetUsd,
        assetCount:
          request.inventory_item_ids.length + request.voucher_ids.length,
        depositsUsd: flow.depositsUsd,
        gameWinsUsd: flow.gameWinsUsd,
        gameLossesUsd: flow.gameLossesUsd,
        rewardsUsd: flow.rewardsUsd,
        gameEvents: flow.gameEvents,
        minutesSinceLastDeposit: flow.minutesSinceLastDeposit,
        accountAgeDays: flow.accountAgeDays,
        otherUsersAtDestination: request.destination_address
          ? (reuseByAddress.get(request.destination_address) ?? 0)
          : 0,
      });
      return { request, sources, flow, ...scored };
    });

    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      for (const assessment of assessments) {
        const { request } = assessment;
        await client.query(
          `
            INSERT INTO withdrawal_assessments(
              withdrawal_id, user_id, username, email, avatar_url, method,
              status, amount_usd, asset_count, requested_at, source_updated_at,
              risk_score, verdict, summary, signals, flow, source_breakdown,
              score_breakdown, flow_checks, assessed_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
              $15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,now()
            )
            ON CONFLICT (withdrawal_id) DO UPDATE SET
              user_id=EXCLUDED.user_id,
              username=EXCLUDED.username,
              email=EXCLUDED.email,
              avatar_url=EXCLUDED.avatar_url,
              method=EXCLUDED.method,
              status=EXCLUDED.status,
              amount_usd=EXCLUDED.amount_usd,
              asset_count=EXCLUDED.asset_count,
              requested_at=EXCLUDED.requested_at,
              source_updated_at=EXCLUDED.source_updated_at,
              risk_score=EXCLUDED.risk_score,
              verdict=EXCLUDED.verdict,
              summary=EXCLUDED.summary,
              signals=EXCLUDED.signals,
              flow=EXCLUDED.flow,
              source_breakdown=EXCLUDED.source_breakdown,
              score_breakdown=EXCLUDED.score_breakdown,
              flow_checks=EXCLUDED.flow_checks,
              assessed_at=now()
          `,
          [
            request.id,
            request.user_id,
            request.username,
            request.email,
            request.image,
            request.method,
            request.status,
            request.total_value_usd,
            request.inventory_item_ids.length + request.voucher_ids.length,
            request.requested_at,
            request.updated_at,
            assessment.riskScore,
            assessment.verdict,
            assessment.summary,
            JSON.stringify(assessment.signals),
            JSON.stringify(assessment.flow),
            JSON.stringify(assessment.sources),
            JSON.stringify(assessment.scoreBreakdown),
            JSON.stringify(assessment.flowChecks),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return {
      ids: requests.rows.map((request) => request.id),
      total: total.rows[0]?.count ?? 0,
    };
  }
}
