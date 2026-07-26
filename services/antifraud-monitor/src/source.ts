import type pg from "pg";

import type { ActiveSession, Signup } from "./types.js";

export async function fetchNewSignups(
  source: pg.Pool,
  cursor: { occurredAt: Date; sourceId: string },
  limit = 100,
): Promise<Signup[]> {
  const result = await source.query<Signup>(
    `
      SELECT
        u.id, u.username, u.email, u.signup_ip, u.country, u.country_code,
        u.continent_code, u.state, u.city, u.affiliate_code, u.referred_by,
        u.is_suspected_alt, u.created_at,
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
      WHERE (u.created_at, u.id) > ($1::timestamptz, $2::text)
        AND u.created_at <= now() - interval '5 seconds'
      ORDER BY u.created_at, u.id
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
                WHERE created_at BETWEEN $2::timestamptz - interval '10 minutes'
                                    AND $2::timestamptz + interval '10 minutes'
              )::text AS same_ip_10m,
              COUNT(*) FILTER (
                WHERE created_at BETWEEN $2::timestamptz - interval '30 minutes'
                                    AND $2::timestamptz + interval '30 minutes'
              )::text AS same_ip_30m
            FROM "user"
            WHERE signup_ip = $1
            AND created_at BETWEEN $2::timestamptz - interval '30 minutes'
                                AND $2::timestamptz + interval '30 minutes'
          `,
          [signup.signup_ip, signup.created_at],
        )
      : Promise.resolve({ rows: [] }),
    signup.signup_ip?.includes(":")
      ? source.query<{ same_ipv6_30m: string }>(
          `
            SELECT COUNT(*)::text AS same_ipv6_30m
            FROM "user"
            WHERE signup_ip IS NOT NULL
              AND family(signup_ip::inet) = 6
              AND network(set_masklen(signup_ip::inet, 64))
                    = network(set_masklen($1::inet, 64))
              AND created_at BETWEEN $2::timestamptz - interval '30 minutes'
                                  AND $2::timestamptz + interval '30 minutes'
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

export async function fetchActivity(
  source: pg.Pool,
  sessions: ActiveSession[],
): Promise<SourceActivity[]> {
  if (sessions.length === 0) return [];
  const ids = sessions.map((session) => session.user_id);
  const since = new Date(
    Math.min(...sessions.map((session) => session.started_at.getTime())) - 2_000,
  );

  const result = await source.query<SourceActivity>(
    `
      SELECT
        lt.user_id,
        CASE
          WHEN lt.type::text = 'deposit' THEN 'deposit'
          WHEN lt.type::text IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed',
                                 'balance_reward_claim','rain_win','waitlist_prize')
            THEN 'bonus_received'
          WHEN lt.type::text = 'pack_opening' THEN 'paid_pack_opened'
          ELSE 'ledger_' || lt.type::text
        END AS event_type,
        'ledger' AS source,
        lt.id::text AS source_ref,
        initcap(replace(lt.type::text, '_', ' ')) AS title,
        lt.description AS detail,
        lt.created_at AS occurred_at,
        jsonb_build_object(
          'type', lt.type::text,
          'amount', lt.amount::text,
          'status', lt.status::text,
          'balance_before', lt.balance_before::text,
          'balance_after', lt.balance_after::text
        ) AS payload
      FROM ledger_transactions lt
      WHERE lt.user_id = ANY($1::text[]) AND lt.created_at >= $2

      UNION ALL

      SELECT
        ur.user_id,
        CASE WHEN ur.opened_at IS NULL THEN 'reward_granted' ELSE 'reward_opened' END,
        'user_rewards',
        ur.id::text,
        CASE WHEN ur.opened_at IS NULL THEN 'Reward granted' ELSE 'Reward opened' END,
        r.name,
        COALESCE(ur.opened_at, ur.granted_at),
        jsonb_build_object(
          'reward_id', ur.reward_id::text,
          'reward_slug', r.slug,
          'reward_name', r.name,
          'reward_type', r.type::text,
          'level_required', r.level_required
        )
      FROM user_rewards ur
      JOIN rewards r ON r.id = ur.reward_id
      WHERE ur.user_id = ANY($1::text[])
        AND COALESCE(ur.opened_at, ur.granted_at) >= $2

      UNION ALL

      SELECT
        re.user_id,
        'rain_joined',
        'rain_entries',
        re.id::text,
        'Joined rain',
        'The monitored account joined a rain.',
        re.created_at,
        jsonb_build_object('rain_id', re.rain_id::text)
      FROM rain_entries re
      WHERE re.user_id = ANY($1::text[]) AND re.created_at >= $2

      ORDER BY occurred_at, source_ref
    `,
    [ids, since],
  );
  return result.rows;
}

export async function topRainWinners(
  source: pg.Pool,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const result = await source.query(
    `
      SELECT
        u.id AS user_id,
        COALESCE(u.display_username, u.username, u.id) AS username,
        COUNT(*)::int AS wins,
        COALESCE(SUM(lt.amount), 0)::text AS total_won_usd,
        MAX(lt.created_at) AS last_win_at
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.type::text = 'rain_win'
        AND lt.status::text = 'completed'
      GROUP BY u.id, COALESCE(u.display_username, u.username, u.id)
      ORDER BY SUM(lt.amount) DESC, COUNT(*) DESC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows;
}
