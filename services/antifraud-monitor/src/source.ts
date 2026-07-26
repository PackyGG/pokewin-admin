import { isIPv6 } from "node:net";

import type pg from "pg";

import type { ActiveSession, Signup } from "./types.js";

/**
 * MAIN stores `user.created_at`, `ledger_transactions.created_at` and
 * `user_rewards.granted_at/opened_at` as `timestamp WITHOUT time zone`.
 * Comparing those naive values against a `timestamptz` cursor makes Postgres
 * promote them using the SERVER session TimeZone, while node-pg parses the
 * returned naive values using the NODE process TZ — two independent
 * conversions that silently shift the cursor when either side is not UTC.
 *
 * Every naive column is therefore read as `<col> AT TIME ZONE 'UTC'` (naive
 * UTC wall clock -> real instant) and every cursor bound is pushed back with
 * `$n::timestamptz AT TIME ZONE 'UTC'` (instant -> naive UTC wall clock).
 * The round trip is then exact regardless of process TZ or server TimeZone.
 */
const UTC = "AT TIME ZONE 'UTC'";
/**
 * node-postgres materialises timestamps as JavaScript Dates, which retain only
 * milliseconds. MAIN can store six fractional digits, so using the raw source
 * timestamp in the read tuple and the truncated Date in the persisted cursor
 * can leave one row permanently after the cursor. Keep both sides and ordering
 * on the precision the application can round-trip exactly.
 */
const CURSOR_MILLISECONDS = "date_trunc('milliseconds', u.created_at)";

/**
 * Strict IPv6 matcher. `user.signup_ip` is plain `text` on MAIN and is never
 * validated, so it can hold an X-Forwarded-For chain, a `host:port` pair or
 * the literal string `unknown`. Casting such a value to `inet` raises
 * `invalid input syntax for type inet`, which aborts the whole tick. Guarding
 * the cast with this pattern inside a `CASE` (Postgres guarantees CASE
 * evaluation order for per-row expressions) makes a malformed value yield
 * NULL instead of an error.
 */
const IPV6_SQL_PATTERN =
  "^(([0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}"
  + "|([0-9A-Fa-f]{1,4}:){1,7}:"
  + "|([0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}"
  + "|([0-9A-Fa-f]{1,4}:){1,5}(:[0-9A-Fa-f]{1,4}){1,2}"
  + "|([0-9A-Fa-f]{1,4}:){1,4}(:[0-9A-Fa-f]{1,4}){1,3}"
  + "|([0-9A-Fa-f]{1,4}:){1,3}(:[0-9A-Fa-f]{1,4}){1,4}"
  + "|([0-9A-Fa-f]{1,4}:){1,2}(:[0-9A-Fa-f]{1,4}){1,5}"
  + "|[0-9A-Fa-f]{1,4}:(:[0-9A-Fa-f]{1,4}){1,6}"
  + "|:((:[0-9A-Fa-f]{1,4}){1,7}|:))$";

/** SQL expression yielding a valid `inet` or NULL for the given text column. */
function safeInet(column: string): string {
  return `(CASE WHEN ${column} ~ '${IPV6_SQL_PATTERN}' THEN ${column} END)::inet`;
}

export function storedIpv6(value: string | null): string | null {
  return value && isIPv6(value) ? value : null;
}

/**
 * Lifetime aggregates on MAIN are capped instead of scanning full history —
 * same 365-day bound the admin dashboard uses for its lifetime windows.
 */
export const RAIN_WINNER_LOOKBACK_DAYS = 365;

export async function fetchNewSignups(
  source: pg.Pool,
  cursor: { occurredAt: Date; sourceId: string },
  limit = 100,
): Promise<Signup[]> {
  const result = await source.query<Signup>(
    `
      SELECT
        u.id, u.username, u.email, u.image, u.signup_ip, u.country, u.country_code,
        u.continent_code, u.state, u.city, u.affiliate_code, u.referred_by,
        u.is_suspected_alt,
        ${CURSOR_MILLISECONDS} ${UTC} AS created_at,
        fp.request_id AS fingerprint_request_id,
        fp.visitor_id,
        fp.confidence AS fingerprint_confidence,
        fp.ip::text AS fingerprint_ip,
        ae.user_agent
      FROM "user" u
      LEFT JOIN LATERAL (
        SELECT request_id, visitor_id, confidence, ip
        FROM fingerprints
        WHERE user_id = u.id AND event_type = 'signup'
        ORDER BY created_at DESC
        LIMIT 1
      ) fp ON true
      LEFT JOIN LATERAL (
        SELECT user_agent
        FROM audit_events
        WHERE user_id = u.id AND event_type = 'register'
        ORDER BY created_at DESC
        LIMIT 1
      ) ae ON true
      WHERE (${CURSOR_MILLISECONDS}, u.id) >
        (date_trunc('milliseconds', $1::timestamptz ${UTC}), $2::text)
        AND u.created_at <= (now() ${UTC}) - interval '5 seconds'
      ORDER BY ${CURSOR_MILLISECONDS}, u.id
      LIMIT $3
    `,
    [cursor.occurredAt, cursor.sourceId, limit],
  );
  return result.rows;
}

export async function signupContext(
  source: pg.Pool,
  signup: Signup,
): Promise<{
  sameIp10m: number;
  sameIp30m: number;
  sameIpv6Subnet30m: number;
  sameDeviceAllTime: number;
}> {
  const [ip, ipv6, device] = await Promise.all([
    signup.signup_ip
      ? source.query<{
          same_ip_10m: string;
          same_ip_30m: string;
        }>(
          `
            SELECT
              COUNT(*) FILTER (
                WHERE created_at BETWEEN ($2::timestamptz ${UTC}) - interval '10 minutes'
                                    AND ($2::timestamptz ${UTC}) + interval '10 minutes'
              )::text AS same_ip_10m,
              COUNT(*) FILTER (
                WHERE created_at BETWEEN ($2::timestamptz ${UTC}) - interval '30 minutes'
                                    AND ($2::timestamptz ${UTC}) + interval '30 minutes'
              )::text AS same_ip_30m
            FROM "user"
            WHERE signup_ip = $1
            AND created_at BETWEEN ($2::timestamptz ${UTC}) - interval '30 minutes'
                                AND ($2::timestamptz ${UTC}) + interval '30 minutes'
          `,
          [signup.signup_ip, signup.created_at],
        )
      : Promise.resolve({ rows: [] }),
    // Only a value Node itself validates as IPv6 may be cast to inet as a
    // query parameter; row values are guarded by `safeInet` instead.
    storedIpv6(signup.signup_ip)
      ? source.query<{ same_ipv6_30m: string }>(
          `
            SELECT COUNT(*)::text AS same_ipv6_30m
            FROM "user"
            WHERE signup_ip IS NOT NULL
              AND family(${safeInet("signup_ip")}) = 6
              AND network(set_masklen(${safeInet("signup_ip")}, 64))
                    = network(set_masklen($1::inet, 64))
              AND created_at BETWEEN ($2::timestamptz ${UTC}) - interval '30 minutes'
                                  AND ($2::timestamptz ${UTC}) + interval '30 minutes'
          `,
          [signup.signup_ip, signup.created_at],
        )
      : Promise.resolve({ rows: [] }),
    signup.visitor_id
      ? source.query<{ count: string }>(
          "SELECT COUNT(DISTINCT user_id)::text AS count FROM fingerprints WHERE visitor_id = $1 AND confidence >= 0.9",
          [signup.visitor_id],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    sameIp10m: Number(ip.rows[0]?.same_ip_10m ?? 0),
    sameIp30m: Number(ip.rows[0]?.same_ip_30m ?? 0),
    sameIpv6Subnet30m: Number(ipv6.rows[0]?.same_ipv6_30m ?? 0),
    sameDeviceAllTime: Number(device.rows[0]?.count ?? 0),
  };
}

export type SourceActivity = {
  user_id: string;
  event_type: string;
  source: string;
  source_ref: string;
  title: string;
  detail: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
};

/**
 * `risk_events` dedupes on `(source, source_ref)` only — the event type is not
 * part of the key. A `user_rewards` row therefore has to expose a DIFFERENT
 * source_ref for its granted and its opened state, otherwise the granted row
 * swallows the opened row and the reward-rush / reward-before-deposit rules
 * can never match.
 */
const USER_REWARD_SOURCE_REF =
  "ur.id::text || CASE WHEN ur.opened_at IS NULL THEN ':granted' ELSE ':opened' END";

export function rewardSourceRef(
  rewardId: string,
  openedAt: Date | null,
): string {
  return `${rewardId}:${openedAt ? "opened" : "granted"}`;
}

export async function fetchActivity(
  source: pg.Pool,
  sessions: ActiveSession[],
  limit = 2_000,
  overlapMs = 2_000,
): Promise<SourceActivity[]> {
  if (sessions.length === 0) return [];
  const perSessionLimit = Math.max(1, Math.floor(limit / sessions.length));
  const batches: SourceActivity[][] = [];
  for (let index = 0; index < sessions.length; index += 8) {
    const chunk = sessions.slice(index, index + 8);
    batches.push(
      ...await Promise.all(
        chunk.map((session) =>
          fetchSessionActivity(source, session, perSessionLimit, overlapMs),
        ),
      ),
    );
  }
  return batches.flat();
}

export async function fetchSessionActivity(
  source: pg.Pool,
  session: ActiveSession,
  limit: number,
  overlapMs: number,
): Promise<SourceActivity[]> {
  const result = await source.query<SourceActivity>(
    `
      WITH candidate_activity AS (
      SELECT
        lt.user_id,
        CASE
          WHEN lt.type::text = 'deposit' AND fdi.id IS NOT NULL THEN 'fiat_deposit'
          WHEN lt.type::text = 'deposit' AND (
            lt.crypto_asset IS NOT NULL
            OR lt.deposit_address_id IS NOT NULL
            OR lt.fireblocks_tx_id IS NOT NULL
            OR lt.blockchain_tx_hash IS NOT NULL
          ) THEN 'crypto_deposit'
          WHEN lt.type::text = 'deposit' THEN 'deposit_unclassified'
          WHEN lt.type::text IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed',
                                 'balance_reward_claim','waitlist_prize')
            THEN 'bonus_received'
          WHEN lt.type::text = 'pack_opening' THEN 'paid_pack_opened'
          ELSE 'ledger_' || lt.type::text
        END AS event_type,
        'ledger' AS source,
        lt.id::text AS source_ref,
        initcap(replace(lt.type::text, '_', ' ')) AS title,
        lt.description AS detail,
        lt.created_at ${UTC} AS occurred_at,
        jsonb_build_object(
          'type', lt.type::text,
          'amount', lt.amount::text,
          'status', lt.status::text,
          'balance_before', lt.balance_before::text,
          'balance_after', lt.balance_after::text,
          'crypto_asset', lt.crypto_asset,
          'crypto_amount', lt.crypto_amount::text,
          'fiat_provider', fdi.provider,
          'fiat_currency', fdi.currency,
          'fiat_status', fdi.status,
          'fiat_requested_amount_cents', fdi.requested_amount_cents,
          'fiat_credited_amount_cents', fdi.credited_amount_cents
        ) AS payload
      FROM ledger_transactions lt
      LEFT JOIN fiat_deposit_intents fdi ON fdi.completed_ledger_id = lt.id
      WHERE lt.user_id = $1
        AND lt.created_at >=
          ($2::timestamptz ${UTC}) - ($5::int * interval '1 millisecond')
        AND lt.type::text <> 'rain_win'

      UNION ALL

      SELECT
        ur.user_id,
        CASE WHEN ur.opened_at IS NULL THEN 'reward_granted' ELSE 'reward_opened' END,
        'user_rewards',
        ${USER_REWARD_SOURCE_REF},
        CASE WHEN ur.opened_at IS NULL THEN 'Reward granted' ELSE 'Reward opened' END,
        r.name,
        COALESCE(ur.opened_at, ur.granted_at) ${UTC},
        jsonb_build_object(
          'reward_id', ur.reward_id::text,
          'reward_slug', r.slug,
          'reward_name', r.name,
          'reward_type', r.type::text,
          'level_required', r.level_required
        )
      FROM user_rewards ur
      JOIN rewards r ON r.id = ur.reward_id
      WHERE ur.user_id = $1
        AND COALESCE(ur.opened_at, ur.granted_at) >=
          ($2::timestamptz ${UTC}) - ($5::int * interval '1 millisecond')
      )
      SELECT *
      FROM candidate_activity
      ORDER BY
        ((occurred_at, source, source_ref) >
          ($2::timestamptz, $3::text, $4::text)) DESC,
        occurred_at,
        source,
        source_ref
      LIMIT $6
    `,
    [
      session.user_id,
      session.activity_cursor_at,
      session.activity_cursor_source,
      session.activity_cursor_ref,
      overlapMs,
      limit,
    ],
  );
  return result.rows;
}

export async function topRainWinners(
  source: pg.Pool,
  limit: number,
  lookbackDays: number = RAIN_WINNER_LOOKBACK_DAYS,
): Promise<Array<Record<string, unknown>>> {
  const result = await source.query(
    `
      SELECT
        u.id AS user_id,
        COALESCE(u.display_username, u.username, u.id) AS username,
        COUNT(*)::int AS wins,
        COALESCE(SUM(lt.amount), 0)::text AS total_won_usd,
        MAX(lt.created_at) ${UTC} AS last_win_at
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.type = 'rain_win'
        AND lt.status = 'completed'
        AND lt.created_at >= (now() ${UTC}) - ($2::int * interval '1 day')
      GROUP BY u.id, COALESCE(u.display_username, u.username, u.id)
      ORDER BY SUM(lt.amount) DESC, COUNT(*) DESC
      LIMIT $1
    `,
    [limit, lookbackDays],
  );
  return result.rows;
}
