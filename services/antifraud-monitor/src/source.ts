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
        u.id, u.name, u.username, u.email, u.image, u.signup_ip, u.country, u.country_code,
        u.continent_code, u.state, u.city, u.affiliate_code, u.referred_by,
        u.is_suspected_alt,
        ${CURSOR_MILLISECONDS} ${UTC} AS created_at,
        fp.request_id AS fingerprint_request_id,
        fp.visitor_id,
        fp.confidence AS fingerprint_confidence,
        fp.ip::text AS fingerprint_ip,
        ae.user_agent,
        auth.auth_provider,
        COALESCE(auth.auth_providers, '[]'::jsonb) AS auth_providers,
        (
          COALESCE(u.role::text, '') = 'creator'
          OR 'creator' = ANY(COALESCE(u.roles::text[], ARRAY[]::text[]))
        ) AS is_creator
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
      LEFT JOIN LATERAL (
        SELECT
          (array_agg(a.provider_id ORDER BY a.created_at NULLS LAST, a.id))[1]
            AS auth_provider,
          jsonb_agg(
            jsonb_build_object(
              'provider', a.provider_id,
              'linkedAt', (a.created_at ${UTC})
            )
            ORDER BY a.created_at NULLS LAST, a.id
          ) AS auth_providers
        FROM account a
        WHERE a.user_id = u.id
      ) auth ON true
      WHERE (${CURSOR_MILLISECONDS}, u.id) >
        (date_trunc('milliseconds', $1::timestamptz ${UTC}), $2::text)
        AND u.created_at <= (now() ${UTC}) - interval '30 seconds'
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
  sameExactIp30d: number;
  sameIpv6Subnet30m: number;
  sameDeviceAllTime: number;
  sameDevice30d: number;
  sameDeviceDistinctIps30d: number;
  sameAffiliate30m: number;
  sameAffiliateIp30m: number;
  sameCountry15m: number;
}> {
  const [ip, ipv6, device, clusters] = await Promise.all([
    signup.signup_ip
      ? source.query<{
          same_ip_10m: string;
          same_ip_30m: string;
          same_ip_30d: string;
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
              ,
              COUNT(*) FILTER (
                WHERE created_at BETWEEN ($2::timestamptz ${UTC}) - interval '30 days'
                                    AND ($2::timestamptz ${UTC}) + interval '30 seconds'
              )::text AS same_ip_30d
            FROM "user"
            WHERE signup_ip = $1
            AND created_at BETWEEN ($2::timestamptz ${UTC}) - interval '30 days'
                                AND ($2::timestamptz ${UTC}) + interval '30 seconds'
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
      ? source.query<{
          count: string;
          count_30d: string;
          distinct_ips_30d: string;
        }>(
          `
            SELECT
              COUNT(DISTINCT user_id)::text AS count,
              COUNT(DISTINCT user_id) FILTER (
                WHERE created_at BETWEEN $2::timestamptz - interval '30 days'
                                     AND $2::timestamptz + interval '30 seconds'
              )::text AS count_30d,
              COUNT(DISTINCT ip) FILTER (
                WHERE created_at BETWEEN $2::timestamptz - interval '30 days'
                                     AND $2::timestamptz + interval '30 seconds'
              )::text AS distinct_ips_30d
            FROM fingerprints
            WHERE visitor_id = $1 AND confidence >= 0.9
          `,
          [signup.visitor_id, signup.created_at],
        )
      : Promise.resolve({ rows: [] }),
    signup.affiliate_code || signup.country_code
      ? source.query<{
          same_affiliate_30m: string;
          same_affiliate_ip_30m: string;
          same_country_15m: string;
        }>(
          `
            SELECT
              COUNT(*) FILTER (
                WHERE $3::text IS NOT NULL
                  AND LOWER(affiliate_code) = LOWER($3::text)
              )::text AS same_affiliate_30m,
              COUNT(*) FILTER (
                WHERE $1::text IS NOT NULL
                  AND $3::text IS NOT NULL
                  AND signup_ip = $1::text
                  AND LOWER(affiliate_code) = LOWER($3::text)
              )::text AS same_affiliate_ip_30m,
              COUNT(*) FILTER (
                WHERE $4::text IS NOT NULL
                  AND UPPER(country_code) = UPPER($4::text)
                  AND created_at BETWEEN
                    ($2::timestamptz ${UTC}) - interval '15 minutes'
                    AND ($2::timestamptz ${UTC}) + interval '15 minutes'
              )::text AS same_country_15m
            FROM "user"
            WHERE created_at BETWEEN
              ($2::timestamptz ${UTC}) - interval '30 minutes'
              AND ($2::timestamptz ${UTC}) + interval '30 minutes'
          `,
          [
            signup.signup_ip,
            signup.created_at,
            signup.affiliate_code,
            signup.country_code,
          ],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    sameIp10m: Number(ip.rows[0]?.same_ip_10m ?? 0),
    sameIp30m: Number(ip.rows[0]?.same_ip_30m ?? 0),
    sameExactIp30d: Number(ip.rows[0]?.same_ip_30d ?? 0),
    sameIpv6Subnet30m: Number(ipv6.rows[0]?.same_ipv6_30m ?? 0),
    sameDeviceAllTime: Number(device.rows[0]?.count ?? 0),
    sameDevice30d: Number(device.rows[0]?.count_30d ?? 0),
    sameDeviceDistinctIps30d: Number(
      device.rows[0]?.distinct_ips_30d ?? 0,
    ),
    sameAffiliate30m: Number(
      clusters.rows[0]?.same_affiliate_30m ?? 0,
    ),
    sameAffiliateIp30m: Number(
      clusters.rows[0]?.same_affiliate_ip_30m ?? 0,
    ),
    sameCountry15m: Number(clusters.rows[0]?.same_country_15m ?? 0),
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
 * swallows the opened row and the reward-specific behavior rules cannot match.
 */
const USER_REWARD_SOURCE_REF =
  "ur.id::text || CASE WHEN ur.opened_at IS NULL THEN ':granted' ELSE ':opened' END";

export const WELCOME_REWARD_PACK_ID =
  "86b89005-d49f-46ad-9c38-f2a35b136eba";
export const LEVEL_ONE_REWARD_PACK_ID =
  "91577f77-8589-4e85-bea1-69bf37c46169";

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
          WHEN lt.type::text = 'deposit' THEN 'crypto_deposit'
          WHEN lt.type::text = 'pack_opening' THEN 'paid_pack_opened'
          ELSE 'ledger_' || lt.type::text
        END AS event_type,
        'ledger' AS source,
        lt.id::text AS source_ref,
        CASE
          WHEN fdi.id IS NOT NULL AND whop.payment_method_type IS NOT NULL
            THEN 'Fiat deposit · ' ||
              CASE whop.payment_method_type
                WHEN 'apple' THEN 'Apple Pay'
                WHEN 'apple_pay' THEN 'Apple Pay'
                WHEN 'google_pay' THEN 'Google Pay'
                WHEN 'cashapp' THEN 'Cash App'
                WHEN 'cash_app' THEN 'Cash App'
                WHEN 'card' THEN 'Card'
                ELSE initcap(replace(whop.payment_method_type, '_', ' '))
              END
          ELSE initcap(replace(lt.type::text, '_', ' '))
        END AS title,
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
          'fiat_credited_amount_cents', fdi.credited_amount_cents,
          'fiat_payment_method_type', whop.payment_method_type,
          'fiat_card_brand', whop.card_brand,
          'fiat_card_last4', whop.card_last4
        ) AS payload
      FROM ledger_transactions lt
      LEFT JOIN fiat_deposit_intents fdi ON fdi.completed_ledger_id = lt.id
      LEFT JOIN LATERAL (
        SELECT
          NULLIF(COALESCE(
            fdi.provider_metadata->>'payment_method_type',
            fdi.provider_metadata->'payment'->>'payment_method_type',
            fdi.provider_metadata->'data'->>'payment_method_type',
            fdi.provider_metadata->'data'->'payment'->>'payment_method_type'
          ), '') AS payment_method_type,
          NULLIF(COALESCE(
            fdi.provider_metadata->>'card_brand',
            fdi.provider_metadata->'payment'->>'card_brand',
            fdi.provider_metadata->'data'->>'card_brand',
            fdi.provider_metadata->'data'->'payment'->>'card_brand'
          ), '') AS card_brand,
          NULLIF(COALESCE(
            fdi.provider_metadata->>'card_last4',
            fdi.provider_metadata->'payment'->>'card_last4',
            fdi.provider_metadata->'data'->>'card_last4',
            fdi.provider_metadata->'data'->'payment'->>'card_last4'
          ), '') AS card_last4
      ) whop ON fdi.id IS NOT NULL
      WHERE lt.user_id = $1
        AND lt.created_at >=
          ($2::timestamptz ${UTC}) - ($5::int * interval '1 millisecond')
        AND lt.created_at <= ($6::timestamptz ${UTC})

      UNION ALL

      SELECT
        ur.user_id,
        CASE
          WHEN '${WELCOME_REWARD_PACK_ID}'::uuid =
            ANY(COALESCE(r.pack_ids, ARRAY[]::uuid[]))
            THEN CASE
              WHEN ur.opened_at IS NULL THEN 'welcome_reward_granted'
              ELSE 'welcome_reward_opened'
            END
          WHEN '${LEVEL_ONE_REWARD_PACK_ID}'::uuid =
            ANY(COALESCE(r.pack_ids, ARRAY[]::uuid[]))
            THEN CASE
              WHEN ur.opened_at IS NULL THEN 'level_one_reward_granted'
              ELSE 'level_one_reward_opened'
            END
          WHEN r.type::text = 'daily'
            THEN CASE
              WHEN ur.opened_at IS NULL THEN 'daily_reward_granted'
              ELSE 'daily_reward_opened'
            END
          ELSE CASE
            WHEN ur.opened_at IS NULL THEN 'other_reward_granted'
            ELSE 'other_reward_opened'
          END
        END,
        'user_rewards',
        ${USER_REWARD_SOURCE_REF},
        r.name || CASE
          WHEN ur.opened_at IS NULL THEN ' granted'
          ELSE ' opened'
        END,
        r.name,
        COALESCE(ur.opened_at, ur.granted_at) ${UTC},
        jsonb_build_object(
          'reward_id', ur.reward_id::text,
          'reward_slug', r.slug,
          'reward_name', r.name,
          'reward_type', r.type::text,
          'level_required', r.level_required,
          'pack_ids', r.pack_ids
        )
      FROM user_rewards ur
      JOIN rewards r ON r.id = ur.reward_id
      WHERE ur.user_id = $1
        AND COALESCE(ur.opened_at, ur.granted_at) >=
          ($2::timestamptz ${UTC}) - ($5::int * interval '1 millisecond')
        AND COALESCE(ur.opened_at, ur.granted_at) <=
          ($6::timestamptz ${UTC})

      UNION ALL

      SELECT
        bp.user_id,
        'creator_sponsored_battle_received',
        'battle_participants',
        bp.id::text || ':sponsored',
        'Sponsored battle received',
        'The account joined a battle funded through sponsorship.',
        bp.created_at ${UTC},
        jsonb_build_object(
          'battle_id', bp.battle_id::text,
          'creator_user_id', b.user_id,
          'creator_has_site_role', (
            COALESCE(creator.role::text, '') = 'creator'
            OR 'creator' = ANY(
              COALESCE(creator.roles::text[], ARRAY[]::text[])
            )
          ),
          'sponsorship_percentage', b.sponsorship_percentage,
          'sponsorship_amount_paid', b.sponsorship_amount_paid::text,
          'creator_session_id', bp.source_session_id::text
        )
      FROM battle_participants bp
      JOIN battles b ON b.id = bp.battle_id
      JOIN "user" creator ON creator.id = b.user_id
      WHERE bp.user_id = $1
        AND (
          b.sponsorship_percentage > 0
          OR bp.source_session_id IS NOT NULL
        )
        AND bp.created_at >=
          ($2::timestamptz ${UTC}) - ($5::int * interval '1 millisecond')
        AND bp.created_at <= ($6::timestamptz ${UTC})

      UNION ALL

      SELECT
        lt.user_id,
        'minimum_withdrawal_runup',
        'ledger',
        lt.id::text || ':minimum-withdrawal-runup',
        'Quick run-up to minimum withdrawal',
        'Fresh reward-derived value reached the minimum withdrawal level before a deposit.',
        lt.created_at ${UTC},
        jsonb_build_object(
          'type', lt.type::text,
          'amount', lt.amount::text,
          'balance_after', lt.balance_after::text,
          'minimum_withdrawal_usd', 10
        )
      FROM ledger_transactions lt
      WHERE lt.user_id = $1
        AND lt.status::text = 'completed'
        AND lt.type::text IN (
          'promo_code_redeemed',
          'balance_reward_claim',
          'gift_card_redeemed',
          'creator_tip',
          'challenge_prize',
          'race_prize',
          'affiliate_leaderboard_prize'
        )
        AND lt.amount > 0
        AND lt.balance_after >= 10
        AND NOT EXISTS (
          SELECT 1
          FROM ledger_transactions deposit
          WHERE deposit.user_id = lt.user_id
            AND deposit.type::text = 'deposit'
            AND deposit.status::text = 'completed'
            AND deposit.created_at <= lt.created_at
        )
        AND lt.created_at >=
          ($2::timestamptz ${UTC}) - ($5::int * interval '1 millisecond')
        AND lt.created_at <= ($6::timestamptz ${UTC})

      UNION ALL

      SELECT
        ses."userId",
        CASE
          WHEN account.created_at < ses.created_at - interval '30 days'
            AND previous.created_at < ses.created_at - interval '30 days'
            AND COALESCE(previous.user_agent, '') <> COALESCE(ses."userAgent", '')
            THEN 'dormant_device_switch'
          ELSE 'session_hopping'
        END,
        'session',
        ses.id,
        CASE
          WHEN account.created_at < ses.created_at - interval '30 days'
            AND previous.created_at < ses.created_at - interval '30 days'
            AND COALESCE(previous.user_agent, '') <> COALESCE(ses."userAgent", '')
            THEN 'Dormant account activated on a new device'
          ELSE 'Rapid session hopping'
        END,
        CASE
          WHEN account.created_at < ses.created_at - interval '30 days'
            AND previous.created_at < ses.created_at - interval '30 days'
            AND COALESCE(previous.user_agent, '') <> COALESCE(ses."userAgent", '')
            THEN 'The account returned after at least 30 inactive days using a different device signature.'
          ELSE 'The account changed device, exact IP, or country repeatedly within 30 minutes.'
        END,
        ses.created_at ${UTC},
        jsonb_build_object(
          'device_key', md5(COALESCE(ses."userAgent", 'unknown')),
          'ip_key', md5(COALESCE(ses."ipAddress", 'unknown')),
          'country_code', ses.country_code,
          'device_count_30m', recent.device_count,
          'ip_count_30m', recent.ip_count,
          'country_count_30m', recent.country_count,
          'previous_session_at', previous.created_at,
          'inactivity_days', FLOOR(
            EXTRACT(EPOCH FROM (ses.created_at - previous.created_at)) / 86400
          )
        )
      FROM session ses
      JOIN "user" account ON account.id = ses."userId"
      JOIN LATERAL (
        SELECT prior.created_at, prior."userAgent" AS user_agent
        FROM session prior
        WHERE prior."userId" = ses."userId"
          AND (prior.created_at, prior.id) < (ses.created_at, ses.id)
        ORDER BY prior.created_at DESC, prior.id DESC
        LIMIT 1
      ) previous ON true
      JOIN LATERAL (
        SELECT
          COUNT(DISTINCT md5(COALESCE(recent_session."userAgent", 'unknown')))::int
            AS device_count,
          COUNT(DISTINCT md5(COALESCE(recent_session."ipAddress", 'unknown')))::int
            AS ip_count,
          COUNT(DISTINCT UPPER(recent_session.country_code)) FILTER (
            WHERE recent_session.country_code IS NOT NULL
          )::int AS country_count
        FROM session recent_session
        WHERE recent_session."userId" = ses."userId"
          AND recent_session.created_at BETWEEN
            ses.created_at - interval '30 minutes' AND ses.created_at
      ) recent ON true
      WHERE ses."userId" = $1
        AND (
          (
            recent.device_count >= 3
            AND (recent.ip_count >= 3 OR recent.country_count >= 2)
          )
          OR (
            account.created_at < ses.created_at - interval '30 days'
            AND previous.created_at < ses.created_at - interval '30 days'
            AND COALESCE(previous.user_agent, '') <> COALESCE(ses."userAgent", '')
          )
        )
        AND ses.created_at >=
          ($2::timestamptz ${UTC}) - ($5::int * interval '1 millisecond')
        AND ses.created_at <= ($6::timestamptz ${UTC})
      )
      SELECT *
      FROM candidate_activity
      ORDER BY
        ((occurred_at, source, source_ref) >
          ($2::timestamptz, $3::text, $4::text)) DESC,
        occurred_at,
        source,
        source_ref
      LIMIT $7
    `,
    [
      session.user_id,
      session.activity_cursor_at,
      session.activity_cursor_source,
      session.activity_cursor_ref,
      overlapMs,
      session.ends_at,
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
