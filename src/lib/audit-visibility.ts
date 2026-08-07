import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { admin_audit_events, admin_users } from "@/lib/db-schema/admin/schema";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { isOwner } from "@/lib/owners";
import type { SessionPayload } from "@/lib/session";

/** Operators whose audit activity is visible only to owners/superowners. */
export const PROTECTED_AUDIT_ACTOR_USERNAMES = ["hifoen"] as const;

export function canViewProtectedAuditActivity(
  session: Pick<SessionPayload, "username" | "isOwner">,
): boolean {
  return isOwner(session);
}

/**
 * Correlated ADMIN-audit predicate. It preserves unattributed/system rows and
 * excludes protected human actors for every non-owner viewer.
 */
export function auditActorVisibilityPredicate(
  canViewProtectedActors: boolean,
  actorIdExpression: SQL = sql`${admin_audit_events.admin_user_id}`,
): SQL {
  if (canViewProtectedActors) return sql`TRUE`;

  return sql`NOT EXISTS (
    SELECT 1
    FROM ${admin_users} AS protected_audit_actor
    WHERE protected_audit_actor.id = ${actorIdExpression}
      AND lower(protected_audit_actor.username) = ANY(${pgArrayParam([
        ...PROTECTED_AUDIT_ACTOR_USERNAMES,
      ])}::text[])
  )`;
}

/** Predicate for the separate Antifraud security-audit table. */
export function antifraudSecurityAuditActorVisibilityPredicate(
  canViewProtectedActors: boolean,
): SQL {
  return canViewProtectedActors
    ? sql`TRUE`
    : sql`(
        actor_username IS NULL
        OR NOT (lower(actor_username) = ANY(${pgArrayParam([
          ...PROTECTED_AUDIT_ACTOR_USERNAMES,
        ])}::text[]))
      )`;
}
