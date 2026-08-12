import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Databases } from "./db.js";
import {
  validateIdentifierInput,
  type IdentifierBlocklistEffect,
  type IdentifierBlocklistKind,
} from "./identifier-blocklists.js";

const actorSchema = z.object({
  idempotencyKey: z.string().uuid(),
  actorId: z.string().trim().min(1).max(200),
  actorUsername: z.string().trim().min(1).max(100).optional(),
});
const paramsSchema = z.object({
  kind: z.enum(["ip", "fingerprint"]),
});
const createSchema = actorSchema.extend({
  value: z.string().trim().min(1).max(255),
  matchMode: z.enum(["exact", "cidr"]).default("exact"),
  reason: z.string().trim().min(4).max(500),
  expiresAt: z.string().datetime().nullable(),
});
const updateSchema = actorSchema.extend({
  enabled: z.boolean(),
  reason: z.string().trim().min(4).max(500),
  expiresAt: z.string().datetime().nullable(),
  effect: z.enum(["block", "known_vpn"]),
});

type RuleRow = {
  id: string;
  kind: IdentifierBlocklistKind;
  value: string;
  match_mode: "exact" | "cidr";
  reason: string;
  source: "manual" | "automatic" | "legacy";
  effect: IdentifierBlocklistEffect;
  enabled: boolean;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  match_count: number;
  affected_users: number;
  matches_24h: number;
  matches_7d: number;
  matches_30d: number;
  first_match_at: Date | null;
  last_match_at: Date | null;
  lock_review_count: number;
  review_only_count: number;
  vpn_detected: boolean;
  vpn_providers: string[];
  vpn_last_detected_at: Date | null;
};

async function listRules(
  db: Databases,
  kind: IdentifierBlocklistKind,
  id?: string,
): Promise<RuleRow[]> {
  const result = await db.antifraud.query<RuleRow>(
    `
      SELECT
        b.id,
        b.kind,
        CASE
          WHEN b.kind='ip' AND b.match_mode='exact' THEN host(b.ip_network)
          WHEN b.kind='ip' THEN b.ip_network::text
          ELSE b.fingerprint_id
        END AS value,
        b.match_mode,
        b.reason,
        b.source,
        b.effect,
        b.enabled,
        b.created_by,
        b.updated_by,
        b.created_at,
        b.updated_at,
        b.expires_at,
        count(m.id)::int AS match_count,
        count(DISTINCT m.user_id)::int AS affected_users,
        count(m.id) FILTER (WHERE m.matched_at >= now()-interval '24 hours')::int
          AS matches_24h,
        count(m.id) FILTER (WHERE m.matched_at >= now()-interval '7 days')::int
          AS matches_7d,
        count(m.id) FILTER (WHERE m.matched_at >= now()-interval '30 days')::int
          AS matches_30d,
        min(m.matched_at) AS first_match_at,
        max(m.matched_at) AS last_match_at,
        count(m.id) FILTER (
          WHERE m.resulting_action IN ('lock_review','locked')
        )::int AS lock_review_count,
        count(m.id) FILTER (WHERE m.resulting_action='review_only')::int
          AS review_only_count,
        COALESCE(vpn.detected, false) AS vpn_detected,
        COALESCE(vpn.providers, ARRAY[]::text[]) AS vpn_providers,
        vpn.last_detected_at AS vpn_last_detected_at
      FROM identifier_blocklists b
      LEFT JOIN identifier_blocklist_matches m ON m.blocklist_id=b.id
      LEFT JOIN LATERAL (
        SELECT
          -- Aggregate-only SELECT with no GROUP BY always returns exactly one
          -- row, so a literal true reported "VPN/proxy detected" on every IP
          -- rule even when no provider_checks row matched. Count the matches.
          count(*) > 0 AS detected,
          array_agg(DISTINCT CASE
            WHEN pc.provider='proxycheck' THEN 'proxycheck.io'
            WHEN pc.provider='abstract_ip' THEN 'Abstract API'
            ELSE 'Provider evidence'
          END) AS providers,
          max(pc.checked_at) AS last_detected_at
        FROM provider_checks pc
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(pc.signals)='array'
            THEN pc.signals ELSE '[]'::jsonb END
        ) signal
        WHERE pc.status='success'
          AND pc.provider IN ('proxycheck','abstract_ip')
          AND pg_input_is_valid(pc.lookup_key, 'inet')
          AND pc.lookup_key::inet <<= b.ip_network
          AND signal->>'key' IN (
            'proxycheck_anonymous','abstract_ip_vpn','abstract_ip_proxy',
            'abstract_ip_tor'
          )
      ) vpn ON b.kind='ip'
      WHERE b.kind=$1 AND ($2::uuid IS NULL OR b.id=$2)
      GROUP BY b.id,vpn.detected,vpn.providers,vpn.last_detected_at
      ORDER BY b.enabled DESC, b.created_at DESC
    `,
    [kind, id ?? null],
  );
  return result.rows;
}

function serialize(row: RuleRow) {
  return {
    id: row.id,
    kind: row.kind,
    value: row.value,
    matchMode: row.match_mode,
    reason: row.reason,
    source: row.source,
    effect: row.effect,
    enabled: row.enabled,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    matchCount: row.match_count,
    affectedUsers: row.affected_users,
    matches24h: row.matches_24h,
    matches7d: row.matches_7d,
    matches30d: row.matches_30d,
    firstMatchAt: row.first_match_at?.toISOString() ?? null,
    lastMatchAt: row.last_match_at?.toISOString() ?? null,
    lockReviewCount: row.lock_review_count,
    reviewOnlyCount: row.review_only_count,
    vpnStatus: row.vpn_detected ? "detected" : "unknown",
    vpnProviders: row.vpn_providers,
    vpnLastDetectedAt: row.vpn_last_detected_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
  };
}

// The backfill used to be one unbounded `INSERT … SELECT` over the whole
// `signup_identity_snapshots` table, issued AFTER the rule had already
// committed. The antifraud pool sets `statement_timeout=15000` (`db.ts`), so a
// broad rule aborted with SQLSTATE 57014 and the route answered 500 for a rule
// that was already live — and the historical sweep silently never ran.
//
// 5_000 snapshot rows per statement: a primary-key-ordered window of that size
// is a few milliseconds of index scan, and even the pathological case where
// every row matches is one bulk insert of 5_000 narrow rows against a single
// unique index — comfortably inside the 15s statement budget with an order of
// magnitude to spare. Smaller chunks would only add round trips against the
// wall-clock budget below.
export const BACKFILL_CHUNK_ROWS = 5_000;
// The dashboard aborts the POST after 8s (`identifier-blocklists-api.ts`), and
// the reply still has to run `listRules`. Stop sweeping at 4s and report the
// sweep as incomplete rather than letting the operator's request time out.
export const BACKFILL_BUDGET_MS = 4_000;

// IP rules match with `<<=`, which no btree index can serve, so the keyset
// cursor has to bound the SNAPSHOT scan: take a fixed window of snapshot rows
// by primary key, then test containment inside that window.
const IP_BACKFILL_CHUNK_SQL = `
  WITH scanned AS (
    SELECT s.user_id, s.signup_ip, s.source_created_at
    FROM signup_identity_snapshots s
    WHERE ($2::text IS NULL OR s.user_id > $2::text)
    ORDER BY s.user_id
    LIMIT $3::int
  ),
  matched AS (
    SELECT b.id AS blocklist_id, s.user_id, s.signup_ip, s.source_created_at
    FROM scanned s
    JOIN identifier_blocklists b ON b.id=$1
    WHERE s.signup_ip IS NOT NULL AND s.signup_ip <<= b.ip_network
  ),
  inserted AS (
    INSERT INTO identifier_blocklist_matches (
      blocklist_id, user_id, source_ref, match_context, resulting_action,
      evidence, matched_at
    )
    SELECT
      m.blocklist_id, m.user_id, 'identity-snapshot:' || m.user_id,
      'historical_backfill', 'review_only',
      jsonb_build_object('signupIp',host(m.signup_ip)),
      m.source_created_at
    FROM matched m
    ON CONFLICT (blocklist_id,user_id,source_ref) DO NOTHING
    RETURNING 1 AS inserted_row
  )
  SELECT
    (SELECT count(*) FROM scanned)::int AS scanned,
    (SELECT count(*) FROM matched)::int AS matched,
    (SELECT count(*) FROM inserted)::int AS inserted,
    (SELECT max(user_id) FROM scanned) AS next_cursor
`;

// Fingerprint rules match on equality, which `signup_identity_snapshot_
// fingerprint_idx` serves directly, so the window is taken over the MATCHED
// set. Walking the whole snapshot keyspace here would turn an instant indexed
// lookup into thousands of round trips.
const FINGERPRINT_BACKFILL_CHUNK_SQL = `
  WITH scanned AS (
    SELECT
      b.id AS blocklist_id, s.user_id, s.fingerprint_visitor_id,
      s.source_created_at
    FROM identifier_blocklists b
    JOIN signup_identity_snapshots s
      ON s.fingerprint_visitor_id=b.fingerprint_id
    WHERE b.id=$1 AND ($2::text IS NULL OR s.user_id > $2::text)
    ORDER BY s.user_id
    LIMIT $3::int
  ),
  inserted AS (
    INSERT INTO identifier_blocklist_matches (
      blocklist_id, user_id, source_ref, match_context, resulting_action,
      evidence, matched_at
    )
    SELECT
      s.blocklist_id, s.user_id, 'identity-snapshot:' || s.user_id,
      'historical_backfill', 'review_only',
      jsonb_build_object('fingerprintVisitorId',s.fingerprint_visitor_id),
      s.source_created_at
    FROM scanned s
    ON CONFLICT (blocklist_id,user_id,source_ref) DO NOTHING
    RETURNING 1 AS inserted_row
  )
  SELECT
    (SELECT count(*) FROM scanned)::int AS scanned,
    (SELECT count(*) FROM scanned)::int AS matched,
    (SELECT count(*) FROM inserted)::int AS inserted,
    (SELECT max(user_id) FROM scanned) AS next_cursor
`;

type BackfillChunkRow = {
  scanned: number;
  matched: number;
  inserted: number;
  next_cursor: string | null;
};

export type BackfillOutcome = {
  scanned: number;
  matched: number;
  inserted: number;
  chunks: number;
  completed: boolean;
  error: string | null;
};

export async function backfillMatches(
  db: Databases,
  ruleId: string,
  kind: IdentifierBlocklistKind,
): Promise<BackfillOutcome> {
  const chunkSql = kind === "ip"
    ? IP_BACKFILL_CHUNK_SQL
    : FINGERPRINT_BACKFILL_CHUNK_SQL;
  const outcome: BackfillOutcome = {
    scanned: 0,
    matched: 0,
    inserted: 0,
    chunks: 0,
    completed: false,
    error: null,
  };
  const deadline = Date.now() + BACKFILL_BUDGET_MS;
  let cursor: string | null = null;
  try {
    for (;;) {
      const rows: BackfillChunkRow[] = (
        await db.antifraud.query<BackfillChunkRow>(
          chunkSql,
          [ruleId, cursor, BACKFILL_CHUNK_ROWS],
        )
      ).rows;
      const chunk: BackfillChunkRow | undefined = rows[0];
      // The outer SELECT is aggregate-only, so a missing row means the driver
      // gave us nothing to trust — stop rather than loop forever.
      if (!chunk) break;
      outcome.chunks += 1;
      outcome.scanned += chunk.scanned;
      outcome.matched += chunk.matched;
      outcome.inserted += chunk.inserted;
      if (chunk.scanned < BACKFILL_CHUNK_ROWS || chunk.next_cursor === null) {
        outcome.completed = true;
        break;
      }
      cursor = chunk.next_cursor;
      // Every window is strictly past the previous cursor, so the loop always
      // terminates; the budget only decides whether it finishes this request.
      if (Date.now() >= deadline) break;
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

export async function registerIdentifierBlocklistRoutes(
  app: FastifyInstance,
  db: Databases,
): Promise<void> {
  app.get("/v1/blocklists/:kind", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_kind" });
    return {
      data: (await listRules(db, params.data.kind)).map(serialize),
    };
  });

  app.post("/v1/blocklists/:kind", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const parsed = createSchema.safeParse(request.body);
    if (
      !params.success
      || !parsed.success
      || !validateIdentifierInput(
        params.data.kind,
        parsed.data.value,
        parsed.data.matchMode,
      )
      || (params.data.kind === "fingerprint"
        && parsed.data.matchMode !== "exact")
    ) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const kind = params.data.kind;
    const normalizedValue = kind === "ip"
      ? (
        await db.antifraud.query<{ value: string }>(
          `SELECT CASE
             WHEN $2 = 'exact' THEN host($1::cidr)
             ELSE $1::cidr::text
           END AS value`,
          [parsed.data.value, parsed.data.matchMode],
        )
      ).rows[0]!.value
      : parsed.data.value.trim();
    const client = await db.antifraud.connect();
    let ruleId: string | null = null;
    let idempotent = false;
    try {
      await client.query("BEGIN");
      const prior = await client.query<{
        blocklist_id: string;
        actor_id: string;
        after_state: { kind?: unknown; value?: unknown };
      }>(
        `SELECT blocklist_id,actor_id,after_state
         FROM identifier_blocklist_audit WHERE idempotency_key=$1`,
        [parsed.data.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (
          prior.rows[0].actor_id !== parsed.data.actorId
          || prior.rows[0].after_state.kind !== kind
          || prior.rows[0].after_state.value !== normalizedValue
        ) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "idempotency_conflict" });
        }
        ruleId = prior.rows[0].blocklist_id;
        idempotent = true;
      } else {
        // PostgreSQL resolves a CASE expression to one common type before it
        // evaluates the condition. Keeping `$2::cidr` in the IP-only branch
        // therefore still tried to cast fingerprint visitor IDs to CIDR and
        // made every fingerprint rule creation fail with 22P02. Use separate
        // statements so a fingerprint value never enters a network cast.
        const insertSql = kind === "ip"
          ? `
            INSERT INTO identifier_blocklists (
              kind,ip_network,fingerprint_id,match_mode,reason,enabled,
              expires_at,created_by,created_by_username,updated_by,
              updated_by_username
            ) VALUES (
              'ip',$2::cidr,NULL,
              $3,$4,true,$5,$6,$7,$6,$7
            )
            ON CONFLICT DO NOTHING
            RETURNING id,
              CASE
                WHEN kind='ip' AND match_mode='exact' THEN host(ip_network)
                WHEN kind='ip' THEN ip_network::text
                ELSE fingerprint_id
              END AS value
          `
          : `
            INSERT INTO identifier_blocklists (
              kind,ip_network,fingerprint_id,match_mode,reason,enabled,
              expires_at,created_by,created_by_username,updated_by,
              updated_by_username
            ) VALUES (
              'fingerprint',NULL,$2,
              $3,$4,true,$5,$6,$7,$6,$7
            )
            ON CONFLICT DO NOTHING
            RETURNING id,fingerprint_id AS value
          `;
        const inserted = await client.query<{ id: string; value: string }>(
          insertSql,
          [
            kind,
            normalizedValue,
            parsed.data.matchMode,
            parsed.data.reason,
            parsed.data.expiresAt,
            parsed.data.actorId,
            parsed.data.actorUsername ?? null,
          ],
        );
        const saved = inserted.rows[0];
        if (!saved) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "identifier_exists" });
        }
        ruleId = saved.id;
        await client.query(
          `
            INSERT INTO identifier_blocklist_audit (
              blocklist_id,action,actor_id,actor_username,reason,
              idempotency_key,after_state
            ) VALUES ($1,'created',$2,$3,$4,$5,$6)
          `,
          [
            ruleId,
            parsed.data.actorId,
            parsed.data.actorUsername ?? null,
            parsed.data.reason,
            parsed.data.idempotencyKey,
            {
              kind,
              value: saved.value,
              matchMode: parsed.data.matchMode,
              reason: parsed.data.reason,
              enabled: true,
              effect: "block",
              expiresAt: parsed.data.expiresAt,
            },
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
    if (!ruleId) return reply.code(500).send({ error: "rule_missing" });
    // Backfill is independently idempotent. Re-run it for idempotent retries so
    // a transient failure after rule creation cannot strand historical matches.
    // The rule is COMMITTED above: the sweep runs afterwards on purpose, and it
    // must never turn a live rule into a 500. Failures and partial sweeps are
    // reported, never thrown.
    const backfill = await backfillMatches(db, ruleId, kind);
    if (backfill.error) {
      request.log.error(
        { blocklistId: ruleId, kind, backfill },
        "blocklist historical backfill failed; rule is live, sweep incomplete",
      );
    } else if (!backfill.completed) {
      request.log.warn(
        { blocklistId: ruleId, kind, backfill },
        "blocklist historical backfill hit its budget; rule is live, sweep incomplete",
      );
    }
    const row = (await listRules(db, kind, ruleId))[0];
    if (!row) return reply.code(500).send({ error: "rule_missing" });
    return reply.code(idempotent ? 200 : 201).send({
      data: { ...serialize(row), idempotent },
      // Sibling of `data`, never inside it: the dashboard parses the rule with
      // a zod object that strips unknown keys, so this is additive for existing
      // clients and available to any operator surface that wants to say "live,
      // historical sweep incomplete".
      backfill: {
        scanned: backfill.scanned,
        matched: backfill.matched,
        inserted: backfill.inserted,
        chunks: backfill.chunks,
        completed: backfill.completed && backfill.error === null,
        failed: backfill.error !== null,
      },
    });
  });

  app.put("/v1/blocklists/:kind/:id", async (request, reply) => {
    const params = paramsSchema
      .extend({ id: z.string().uuid() })
      .safeParse(request.params);
    const parsed = updateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const client = await db.antifraud.connect();
    let idempotent = false;
    try {
      await client.query("BEGIN");
      const prior = await client.query<{
        blocklist_id: string;
        actor_id: string;
        after_state: {
          enabled?: unknown;
          reason?: unknown;
          expiresAt?: unknown;
          effect?: unknown;
        };
      }>(
        `SELECT blocklist_id,actor_id,after_state
         FROM identifier_blocklist_audit WHERE idempotency_key=$1`,
        [parsed.data.idempotencyKey],
      );
      if (prior.rows[0]) {
        const state = prior.rows[0];
        if (
          state.blocklist_id !== params.data.id
          || state.actor_id !== parsed.data.actorId
          || state.after_state.enabled !== parsed.data.enabled
          || state.after_state.reason !== parsed.data.reason
          || state.after_state.expiresAt !== parsed.data.expiresAt
          || state.after_state.effect !== parsed.data.effect
        ) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "idempotency_conflict" });
        }
        idempotent = true;
      } else {
        const before = await client.query<{
          id: string;
          kind: IdentifierBlocklistKind;
          enabled: boolean;
          reason: string;
          expires_at: Date | null;
          effect: IdentifierBlocklistEffect;
        }>(
          `SELECT id,kind,enabled,reason,expires_at,effect
           FROM identifier_blocklists
           WHERE id=$1 AND kind=$2 FOR UPDATE`,
          [params.data.id, params.data.kind],
        );
        const current = before.rows[0];
        if (!current) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "not_found" });
        }
        if (params.data.kind !== "ip" && parsed.data.effect !== "block") {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "invalid_effect" });
        }
        await client.query(
          `UPDATE identifier_blocklists SET
             enabled=$2,reason=$3,expires_at=$4,updated_by=$5,
             updated_by_username=$6,effect=$7,updated_at=now()
           WHERE id=$1`,
          [
            params.data.id,
            parsed.data.enabled,
            parsed.data.reason,
            parsed.data.expiresAt,
            parsed.data.actorId,
            parsed.data.actorUsername ?? null,
            parsed.data.effect,
          ],
        );
        const action = current.enabled === parsed.data.enabled
          ? "updated"
          : parsed.data.enabled
            ? "reactivated"
            : "disabled";
        await client.query(
          `INSERT INTO identifier_blocklist_audit (
             blocklist_id,action,actor_id,actor_username,reason,
             idempotency_key,before_state,after_state
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            params.data.id,
            action,
            parsed.data.actorId,
            parsed.data.actorUsername ?? null,
            parsed.data.reason,
            parsed.data.idempotencyKey,
            {
              enabled: current.enabled,
              reason: current.reason,
              expiresAt: current.expires_at?.toISOString() ?? null,
              effect: current.effect,
            },
            {
              enabled: parsed.data.enabled,
              reason: parsed.data.reason,
              expiresAt: parsed.data.expiresAt,
              effect: parsed.data.effect,
            },
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
    const row = (await listRules(db, params.data.kind, params.data.id))[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { data: { ...serialize(row), idempotent } };
  });
}
