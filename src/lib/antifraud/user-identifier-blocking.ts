import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

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

/**
 * Permanently block every IP and/or Fingerprint visitor ID currently tied to
 * one user. Callers use the explicit MAIN mutation client so the identifier
 * snapshot and the account mutation observe the same selected environment.
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

  let changedCount = 0;
  if (ips.length > 0) {
    changedCount += await ensureKindBlocked({
      kind: "ip",
      values: ips,
      reason: input.reason,
      actorId: input.actorId,
      actorUsername: input.actorUsername,
    });
  }
  if (fingerprints.length > 0) {
    changedCount += await ensureKindBlocked({
      kind: "fingerprint",
      values: fingerprints,
      reason: input.reason,
      actorId: input.actorId,
      actorUsername: input.actorUsername,
    });
  }

  return {
    ipCount: ips.length,
    fingerprintCount: fingerprints.length,
    changedCount,
  };
}
