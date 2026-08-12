import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import type { MainDrizzleDb } from "@/lib/db";
import {
  createIdentifierBlocklistRule,
  listIdentifierBlocklist,
  updateIdentifierBlocklistRule,
  type IdentifierBlocklistKind,
  type IdentifierBlocklistRule,
} from "@/lib/antifraud/identifier-blocklists-api";

type IdentifierRow = {
  kind: IdentifierBlocklistKind;
  value: string;
};

export type UserIdentifierBlockResult = {
  ipCount: number;
  fingerprintCount: number;
  changedCount: number;
  deliveryStatus: "applied" | "pending";
  operationId: string;
};

type IdentifierBlockOperation = {
  id: string;
  userId: string;
  ipValues: string[];
  fingerprintValues: string[];
  reason: string;
  actorId: string;
  actorUsername?: string;
};

async function loadKnownIdentifiers(
  db: MainDrizzleDb,
  userId: string,
  requestedKind?: IdentifierBlocklistKind,
): Promise<IdentifierRow[]> {
  const result = await db.execute<IdentifierRow>(sql`
    SELECT DISTINCT identifiers.kind, identifiers.value
    FROM (
      SELECT 'ip'::text AS kind,
             host(NULLIF(BTRIM(u.signup_ip), '')::inet) AS value
      FROM "user" u
      WHERE u.id = ${userId}

      UNION

      SELECT 'ip'::text AS kind, host(f.ip) AS value
      FROM fingerprints f
      WHERE f.user_id = ${userId} AND f.ip IS NOT NULL

      UNION

      SELECT 'fingerprint'::text AS kind,
             NULLIF(BTRIM(f.visitor_id), '') AS value
      FROM fingerprints f
      WHERE f.user_id = ${userId}
    ) identifiers
    WHERE identifiers.value IS NOT NULL
      AND (${requestedKind ?? null}::text IS NULL
        OR identifiers.kind = ${requestedKind ?? null})
    ORDER BY identifiers.kind, identifiers.value
  `);
  return result.rows;
}

function needsReactivation(rule: IdentifierBlocklistRule): boolean {
  return !rule.enabled || rule.expiresAt !== null;
}

async function ensureKindBlocked(input: {
  kind: IdentifierBlocklistKind;
  values: string[];
  reason: string;
  actorId: string;
  actorUsername?: string;
}): Promise<number> {
  const initial = await listIdentifierBlocklist(input.kind);
  if (!initial.configured) {
    throw new Error("The Antifraud monitor API is not configured.");
  }
  if (initial.error) {
    throw new Error(`The ${input.kind} blocklist could not be loaded.`);
  }

  const byValue = new Map(initial.data.map((rule) => [rule.value, rule]));
  let changed = 0;

  // Keep the monitor API responsive if an account accumulated many browser
  // identifiers over time. Every value is still processed before returning.
  for (let offset = 0; offset < input.values.length; offset += 8) {
    const batch = input.values.slice(offset, offset + 8);
    const results = await Promise.all(
      batch.map(async (value) => {
        const existing = byValue.get(value);
        // A public VPN deliberately downgraded by staff must stay non-blocking,
        // even when one of its users is later banned.
        if (existing?.effect === "known_vpn") return false;
        if (existing && !needsReactivation(existing)) return false;
        if (existing) {
          await updateIdentifierBlocklistRule({
            kind: input.kind,
            id: existing.id,
            enabled: true,
            reason: input.reason,
            expiresAt: null,
            idempotencyKey: randomUUID(),
            actorId: input.actorId,
            actorUsername: input.actorUsername,
            effect: "block",
          });
          return true;
        }

        try {
          await createIdentifierBlocklistRule({
            kind: input.kind,
            value,
            matchMode: "exact",
            reason: input.reason,
            expiresAt: null,
            idempotencyKey: randomUUID(),
            actorId: input.actorId,
            actorUsername: input.actorUsername,
          });
          return true;
        } catch (error) {
          // A concurrent operator may have inserted the same normalized IP
          // between our list and create. Re-read once and accept only an
          // active permanent rule; every other failure remains fail-closed.
          if (!(error instanceof Error) || !/already on the blocklist/i.test(error.message)) {
            throw error;
          }
          const refreshed = await listIdentifierBlocklist(input.kind);
          const concurrent = refreshed.data.find((rule) => rule.value === value);
          if (refreshed.error || !concurrent || needsReactivation(concurrent)) {
            throw error;
          }
          return false;
        }
      }),
    );
    changed += results.filter(Boolean).length;
  }

  return changed;
}

async function recordIdentifierBlockOperation(input: {
  userId: string;
  ips: string[];
  fingerprints: string[];
  reason: string;
  actorId: string;
  actorUsername?: string;
}): Promise<IdentifierBlockOperation> {
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    INSERT INTO antifraud_identifier_blocking_outbox (
      target_user_id, ip_values, fingerprint_values, reason,
      actor_id, actor_username
    ) VALUES (
      ${input.userId}, ${JSON.stringify(input.ips)}::jsonb,
      ${JSON.stringify(input.fingerprints)}::jsonb, ${input.reason},
      ${input.actorId}, ${input.actorUsername ?? null}
    )
    RETURNING id::text
  `);
  return {
    id: result.rows[0]!.id,
    userId: input.userId,
    ipValues: input.ips,
    fingerprintValues: input.fingerprints,
    reason: input.reason,
    actorId: input.actorId,
    actorUsername: input.actorUsername,
  };
}

/**
 * Apply one already-durable identifier obligation. Remote failures never
 * erase or reject the obligation: they schedule an unlimited exponential
 * retry and return pending so the account ban may continue independently.
 */
export async function applyIdentifierBlockOperation(
  operation: IdentifierBlockOperation,
): Promise<UserIdentifierBlockResult> {
  try {
    let changedCount = 0;
    if (operation.ipValues.length > 0) {
      changedCount += await ensureKindBlocked({
        kind: "ip",
        values: operation.ipValues,
        reason: operation.reason,
        actorId: operation.actorId,
        actorUsername: operation.actorUsername,
      });
    }
    if (operation.fingerprintValues.length > 0) {
      changedCount += await ensureKindBlocked({
        kind: "fingerprint",
        values: operation.fingerprintValues,
        reason: operation.reason,
        actorId: operation.actorId,
        actorUsername: operation.actorUsername,
      });
    }
    await adminDrizzle.execute(sql`
      UPDATE antifraud_identifier_blocking_outbox
      SET status = 'applied', error = NULL, claimed_until = NULL,
          applied_at = now(), updated_at = now()
      WHERE id = ${operation.id}::uuid
    `);
    return {
      ipCount: operation.ipValues.length,
      fingerprintCount: operation.fingerprintValues.length,
      changedCount,
      deliveryStatus: "applied",
      operationId: operation.id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await adminDrizzle.execute(sql`
        UPDATE antifraud_identifier_blocking_outbox
        SET status = 'failed', error = ${message.slice(0, 2000)},
            claimed_until = NULL, updated_at = now(),
            next_attempt_at = now() + make_interval(
              secs => LEAST(300, 5 * power(2, LEAST(GREATEST(attempts - 1, 0), 6))::integer)
            )
        WHERE id = ${operation.id}::uuid
      `);
    } catch (recordError) {
      // The row was committed as pending before remote I/O. If this update is
      // unavailable, leaving it pending makes the next cron sweep retry it.
      console.error("[antifraud-identifier-outbox] failed to record retry", {
        operationId: operation.id,
        error: message,
        recordError,
      });
    }
    return {
      ipCount: operation.ipValues.length,
      fingerprintCount: operation.fingerprintValues.length,
      changedCount: 0,
      deliveryStatus: "pending",
      operationId: operation.id,
    };
  }
}

export async function claimPendingIdentifierBlockOperations(
  limit: number,
): Promise<IdentifierBlockOperation[]> {
  const result = await adminDrizzle.execute<{
    id: string;
    target_user_id: string;
    ip_values: unknown;
    fingerprint_values: unknown;
    reason: string;
    actor_id: string;
    actor_username: string | null;
  }>(sql`
    WITH candidates AS (
      SELECT id
      FROM antifraud_identifier_blocking_outbox
      WHERE status IN ('pending', 'failed')
        AND next_attempt_at <= now()
        AND (claimed_until IS NULL OR claimed_until <= now())
      ORDER BY next_attempt_at, created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE antifraud_identifier_blocking_outbox AS row
    SET attempts = LEAST(row.attempts + 1, 2147483647),
        claimed_until = now() + interval '2 minutes', updated_at = now()
    FROM candidates
    WHERE row.id = candidates.id
    RETURNING row.id::text, row.target_user_id, row.ip_values,
      row.fingerprint_values, row.reason, row.actor_id, row.actor_username
  `);
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.target_user_id,
    ipValues: strings(row.ip_values),
    fingerprintValues: strings(row.fingerprint_values),
    reason: row.reason,
    actorId: row.actor_id,
    actorUsername: row.actor_username ?? undefined,
  }));
}

/**
 * Durably schedule a permanent block for every IP and/or Fingerprint visitor
 * ID currently tied to one user. Callers use the explicit MAIN mutation
 * client so the identifier snapshot and the account mutation observe the same
 * selected environment. Remote Antifraud I/O is intentionally left to the
 * retry worker so it can never delay or cancel the authoritative account ban.
 */
export async function blockKnownUserIdentifiers(input: {
  db: MainDrizzleDb;
  userId: string;
  kind?: IdentifierBlocklistKind;
  reason: string;
  actorId: string;
  actorUsername?: string;
}): Promise<UserIdentifierBlockResult> {
  const identifiers = await loadKnownIdentifiers(
    input.db,
    input.userId,
    input.kind,
  );
  const ips = identifiers
    .filter((row) => row.kind === "ip")
    .map((row) => row.value);
  const fingerprints = identifiers
    .filter((row) => row.kind === "fingerprint")
    .map((row) => row.value);

  // Commit the obligation before any remote call. This is the hard boundary:
  // if ADMIN persistence is unavailable, callers still fail closed; once the
  // row exists, a monitor outage can never make the work disappear or prevent
  // the authoritative account ban from proceeding.
  const operation = await recordIdentifierBlockOperation({
    userId: input.userId,
    ips,
    fingerprints,
    reason: input.reason,
    actorId: input.actorId,
    actorUsername: input.actorUsername,
  });
  return {
    ipCount: ips.length,
    fingerprintCount: fingerprints.length,
    changedCount: 0,
    deliveryStatus: "pending",
    operationId: operation.id,
  };
}
