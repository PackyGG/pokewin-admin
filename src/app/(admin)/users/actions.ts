"use server";

import { pgArrayParam } from "@/lib/drizzle-array-param";
import { revalidatePath, revalidateTag } from "next/cache";
import { getPrimaryDrizzleDb } from "@/lib/db";
import { adminDrizzle, sql } from "@/lib/drizzle";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { require2FA } from "@/lib/require-2fa";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { resolveAdminMainUserId } from "@/lib/resolve-admin-main-user-id";
import { getDistinctUserCountries } from "@/lib/queries/users-export";
import {
  getUserIdsMatchingFilters,
  getBannedUserIdsMatchingFilters,
  getBulkUnbanPreviewUsers,
  BULK_BAN_MAX,
  type BulkUnbanFilters,
  type BulkUnbanPreviewUser,
} from "@/lib/queries/users-list";
import { requireUsersExportAdmin } from "@/lib/users-export/motha-gate";
import {
  getAllUsersForExport,
  allUsersToCsv,
} from "@/lib/users-export/all-users-csv";
import {
  buildUserSnapshot,
  snapshotToJsonValue,
} from "@/lib/deleted-users/snapshot";
import { ok, fail, type ServerActionResult } from "@/lib/errors/server-action-result";
import { logError } from "@/lib/errors/logger";
import { userDetailTag } from "@/lib/queries/users-detail-cache";
import {
  blockKnownUserIdentifiers,
  type UserIdentifierBlockResult,
} from "@/lib/antifraud/user-identifier-blocking";
import { z } from "zod";
import {
  getFingerprintAltAccounts,
  type FingerprintAltAccount,
} from "@/lib/queries/user-fingerprint-alts";

// 7-day soft-delete window for admin_deleted_users snapshots. Mirrored
// in /users/deleted's purge-on-read scan and the restore action's
// expiry check.
const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Lazily-fetched list of distinct user countries. Used by the Export
 * dialog's country filter. The query was previously eager-fetched on
 * every /users page render even though the dialog is opened rarely —
 * this server action lets the dialog defer the lookup until it's
 * actually opened. Page-level cost goes from ~1 wide-table scan per
 * render to zero for the common path of admins listing users without
 * exporting.
 */
export async function fetchDistinctUserCountries() {
  await requirePageAccess("/users");
  return getDistinctUserCountries();
}

/**
 * Ban a user account. Atomically: flip is_banned + capture reason +
 * tombstone every active session so they're kicked out instantly.
 * Returns ServerActionResult — callers check `result.success`.
 */
export async function banUser(
  userId: string,
  reason: string,
): Promise<
  ServerActionResult<{
    userId: string;
    identifiers: UserIdentifierBlockResult;
  }>
> {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/users");
  try {
    await requireCapability(session, "__can_ban_users", "ban users");
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "Permission denied",
      "FORBIDDEN",
    );
  }

  if (!reason || !reason.trim()) {
    return fail("Ban reason is required.", "VALIDATION");
  }

  // `user.banned_by` is a nullable FK to Main-DB `User.id`. Admin
  // identities live in the Admin DB so we resolve via email match;
  // unlinked admins fall back to null and the audit event below
  // remains the source of truth for who actually triggered the ban.
  const issuerMainUserId = await resolveAdminMainUserId(session.userId);

  let identifiers: UserIdentifierBlockResult;
  try {
    identifiers = await blockKnownUserIdentifiers({
      db,
      userId,
      reason: `Account ban: ${reason.trim()}`.slice(0, 500),
      actorId: session.userId,
      actorUsername: session.username ?? undefined,
    });
  } catch (err) {
    logError(
      "users.ban.identifiers",
      `identifier blocklist failed for ${userId}`,
      err,
    );
    return fail(
      "Couldn't blacklist this user's IP and fingerprint, so the account was not banned.",
    );
  }

  try {
    await db.transaction(async (tx) => {
      const updated = await tx.execute(sql`
        UPDATE "user"
        SET is_banned = TRUE,
            banned_reason = ${reason.trim()},
            banned_at = NOW(),
            banned_by = ${issuerMainUserId},
            updated_at = NOW()
        WHERE id = ${userId}
        RETURNING id
      `);
      if (updated.rows.length === 0) throw new Error("No record was found");
      await tx.execute(sql`DELETE FROM session WHERE "userId" = ${userId}`);
    });
  } catch (err) {
    logError("users.ban", `ban transaction failed for ${userId}`, err);
    // The RETURNING guard reports a user that was already deleted.
    if (err instanceof Error && /No record was found/i.test(err.message)) {
      return fail("User not found.", "NOT_FOUND");
    }
    return fail("Couldn't ban this user — please try again.");
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_banned",
    targetUserId: userId,
    metadata: {
      reason,
      issuer_main_user_id: issuerMainUserId,
      blacklisted_ip_count: identifiers.ipCount,
      blacklisted_fingerprint_count: identifiers.fingerprintCount,
      blocklist_changes: identifiers.changedCount,
      identifier_delivery_status: identifiers.deliveryStatus,
      identifier_operation_id: identifiers.operationId,
    },
  });

  // Narrow tag flushes ONLY — no revalidatePath. A path revalidation
  // re-renders the entire route on the action response (the scroll-jump
  // use-toggle-action.ts exists to prevent), and unstable_cache ignores
  // it anyway. The list tags cover the /users ranking/ids caches (≤300s
  // TTL) + KPI strip (60s); userDetailTag busts this user's /users/[id]
  // detail caches so the streamed re-sync serves fresh truth. /chat has
  // no server-rendered ban state (banned feedback there is client-side).
  revalidateTag("users-list");
  revalidateTag("users-list-stats");
  revalidateTag(userDetailTag(userId));
  return ok({ userId, identifiers });
}

const blockUserIdentifierSchema = z.object({
  userId: z.string().trim().min(1).max(100),
  kind: z.enum(["ip", "fingerprint"]),
  confirmed: z.literal(true),
});

/** Permanently block only the selected identifier class for one user. */
export async function blockUserIdentifiers(
  input: unknown,
): Promise<ServerActionResult<UserIdentifierBlockResult>> {
  const session = await requirePageAccess("/users");
  try {
    await requireCapability(session, "__can_ban_users", "ban user identifiers");
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "Permission denied",
      "FORBIDDEN",
    );
  }
  const parsed = blockUserIdentifierSchema.safeParse(input);
  if (!parsed.success) {
    return fail(parsed.error.issues[0].message, "VALIDATION");
  }

  const db = await getPrimaryDrizzleDb();
  let identifiers: UserIdentifierBlockResult;
  try {
    identifiers = await blockKnownUserIdentifiers({
      db,
      userId: parsed.data.userId,
      kind: parsed.data.kind,
      reason: `Blocked from user profile (${parsed.data.userId})`,
      actorId: session.userId,
      actorUsername: session.username ?? undefined,
    });
  } catch (err) {
    logError(
      "users.blockIdentifiers",
      `${parsed.data.kind} blocklist failed for ${parsed.data.userId}`,
      err,
    );
    return fail(`Couldn't blacklist this user's ${parsed.data.kind}.`);
  }

  const blockedCount =
    parsed.data.kind === "ip"
      ? identifiers.ipCount
      : identifiers.fingerprintCount;
  if (blockedCount === 0) {
    return fail(
      parsed.data.kind === "ip"
        ? "This user has no known IP address to blacklist."
        : "This user has no known fingerprint to blacklist.",
      "NOT_FOUND",
    );
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_user_identifiers_blocklisted",
    targetUserId: parsed.data.userId,
    metadata: {
      kind: parsed.data.kind,
      blocked_count: blockedCount,
      changed_count: identifiers.changedCount,
      source: "users_detail",
    },
  });
  revalidatePath(
    parsed.data.kind === "ip"
      ? "/antifraud/ip-blacklist"
      : "/antifraud/fingerprint-blacklist",
  );
  return ok(identifiers);
}

export async function unbanUser(userId: string) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_ban_users", "unban users");

  const updated = await db.execute(sql`
    UPDATE "user"
    SET is_banned = FALSE, banned_reason = NULL, banned_at = NULL,
        banned_by = NULL, updated_at = NOW()
    WHERE id = ${userId}
    RETURNING id
  `);
  if (updated.rows.length === 0) throw new Error("User not found");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_unbanned",
    targetUserId: userId,
  });

  // Narrow tag flushes only — see banUser (no revalidatePath = no jump).
  revalidateTag("users-list");
  revalidateTag("users-list-stats");
  revalidateTag(userDetailTag(userId));
}

/**
 * Lock a user account (softer than ban — they can still log in but
 * gambling / withdraw paths are gated). Returns ServerActionResult.
 */
export async function lockUser(
  userId: string,
  reason: string,
): Promise<ServerActionResult<{ userId: string }>> {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/users");
  try {
    await requireCapability(session, "__can_lock_users", "lock user accounts");
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "Permission denied",
      "FORBIDDEN",
    );
  }

  if (!reason || !reason.trim()) {
    return fail("Lock reason is required.", "VALIDATION");
  }

  // `user.locked_by` is a nullable FK to Main-DB `User.id`. Same
  // resolution as `banUser` — admin → main user via email; null when
  // no match. Audit event is the canonical trail.
  const issuerMainUserId = await resolveAdminMainUserId(session.userId);

  try {
    const updated = await db.execute(sql`
      UPDATE "user"
      SET is_locked = TRUE,
          locked_reason = ${reason.trim()},
          locked_at = NOW(),
          locked_by = ${issuerMainUserId},
          updated_at = NOW()
      WHERE id = ${userId}
      RETURNING id
    `);
    if (updated.rows.length === 0) throw new Error("No record was found");
  } catch (err) {
    logError("users.lock", `lock transaction failed for ${userId}`, err);
    if (err instanceof Error && /No record was found/i.test(err.message)) {
      return fail("User not found.", "NOT_FOUND");
    }
    return fail("Couldn't lock this user — please try again.");
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_locked",
    targetUserId: userId,
    metadata: { reason, issuer_main_user_id: issuerMainUserId },
  });

  // Narrow tag flushes only — see banUser (no revalidatePath = no jump).
  revalidateTag("users-list");
  revalidateTag("users-list-stats");
  revalidateTag(userDetailTag(userId));
  return ok({ userId });
}

export async function unlockUser(userId: string) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_lock_users", "unlock user accounts");

  const updated = await db.execute(sql`
    UPDATE "user"
    SET is_locked = FALSE, locked_reason = NULL, locked_at = NULL,
        locked_by = NULL, locked_until = NULL, updated_at = NOW()
    WHERE id = ${userId}
    RETURNING id
  `);
  if (updated.rows.length === 0) throw new Error("User not found");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_unlocked",
    targetUserId: userId,
  });

  // Narrow tag flushes only — see banUser (no revalidatePath = no jump).
  revalidateTag("users-list");
  revalidateTag("users-list-stats");
  revalidateTag(userDetailTag(userId));
}

/**
 * motha-ONLY "export all users" CSV. Distinct from the capability-gated
 * `/api/users/export` dialog (rich filters, any admin): this is a
 * one-click raw dump of EVERY user as exactly three columns — email,
 * username, deposit amount — restricted to the single `motha` admin.
 *
 * `requireUsersExportAdmin()` is the real gate: it re-reads the live
 * username from the DB and THROWS for anyone who isn't motha, so a
 * non-motha admin/support/marketing/creator gets the error, never the
 * data. Hiding the button client-side is defense-in-depth only.
 *
 * Returns the CSV string + a filename for the client to Blob + download
 * (the house "action returns string → client triggers download"
 * pattern). Audited via `users_all_export` with the ROW COUNT ONLY —
 * never the emails/amounts themselves (no row PII in the audit log,
 * per CLAUDE.md).
 */
export async function exportAllUsersCsv(): Promise<{
  csv: string;
  filename: string;
}> {
  const session = await requireUsersExportAdmin();

  const rows = await getAllUsersForExport();
  const csv = allUsersToCsv(rows);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "users_all_export",
    metadata: { rows: rows.length },
  });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return { csv, filename: `all-users-${ts}.csv` };
}

export async function bulkDeleteUsers(userIds: string[], totpCode: string) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_bulk_delete_users", "bulk-delete users");
  await require2FA(session.userId, totpCode);

  if (userIds.length === 0) throw new Error("No users selected");
  if (userIds.length > 100) throw new Error("Max 100 users at once");

  const users = (
    await db.execute<{
      id: string;
      username: string | null;
      email: string | null;
    }>(sql`
      SELECT id, username, email
      FROM "user"
      WHERE id = ANY(${pgArrayParam(userIds)}::text[])
    `)
  ).rows;

  const labels = new Map(
    users.map((u) => [u.id, u.username ?? u.email ?? u.id]),
  );
  const emails = new Map(users.map((u) => [u.id, u.email ?? null]));
  const usernames = new Map(users.map((u) => [u.id, u.username ?? null]));

  // Build snapshots in parallel — each user's reads are independent.
  // If any snapshot build throws we abort the whole bulk delete; no
  // main-DB writes have happened yet so this is safe.
  const snapshots: Awaited<ReturnType<typeof buildUserSnapshot>>[] = [];
  for (let offset = 0; offset < userIds.length; offset += 5) {
    snapshots.push(
      ...(await Promise.all(
        userIds.slice(offset, offset + 5).map((id) => buildUserSnapshot(db, id)),
      )),
    );
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SNAPSHOT_RETENTION_MS);

  // Upsert all snapshots before touching the main DB. We use Promise.all
  // over individual upserts (not createMany) because JSONB + upsert
  // semantics + restored_at-clear-on-overwrite need per-row handling.
  // If the admin DB blows up here, the main DB hasn't been touched yet.
  const snapshotRows = userIds.map((id, idx) => ({
    id,
    username: usernames.get(id) ?? null,
    email: emails.get(id) ?? null,
    snapshot: snapshotToJsonValue(snapshots[idx]),
  }));
  await adminDrizzle.execute(sql`
    INSERT INTO admin_deleted_users (
      id, username, email, deleted_at, deleted_by, expires_at, snapshot
    )
    SELECT r.id, r.username, r.email, ${now}, ${session.userId},
           ${expiresAt}, r.snapshot
    FROM jsonb_to_recordset(${JSON.stringify(snapshotRows)}::jsonb)
      AS r(id varchar(36), username varchar(255), email varchar(255), snapshot jsonb)
    ON CONFLICT (id) DO UPDATE SET
      username = EXCLUDED.username,
      email = EXCLUDED.email,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by,
      expires_at = EXCLUDED.expires_at,
      snapshot = EXCLUDED.snapshot,
      restored_at = NULL,
      restored_by = NULL
  `);

  // Audit AFTER the snapshots land so the audit row references the
  // backups that actually exist.
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "users_bulk_deleted",
    metadata: {
      count: userIds.length,
      users: userIds.map((id, idx) => ({
        id,
        username: labels.get(id) ?? id,
        truncated: snapshots[idx]._truncated,
      })),
      snapshot_expires_at: expiresAt.toISOString(),
    },
  });

  // Destructive delete. On failure we roll back the snapshots we just
  // inserted — best-effort so /users/deleted doesn't fill with ghosts.
  try {
    await db.execute(sql`DELETE FROM "user" WHERE id = ANY(${pgArrayParam(userIds)}::text[])`);
  } catch (err) {
    await adminDrizzle
      .execute(sql`DELETE FROM admin_deleted_users WHERE id = ANY(${pgArrayParam(userIds)}::text[])`)
      .catch(() => {
        console.error(
          `[bulkDeleteUsers] failed to roll back ${userIds.length} snapshots after main-DB deleteMany failure`,
        );
      });
    throw err;
  }

  revalidatePath("/users");
  revalidatePath("/users/deleted");
  // Tag flush — see banUser; deleting users changes both the cached
  // ranking ids and the global KPI counts.
  revalidateTag("users-list");
  revalidateTag("users-list-stats");
}

/** Admin OR owner. Bulk actions are stricter than the support-level single ban. */
function isBulkBanAuthorized(session: {
  role?: string;
  roles?: string[];
  isOwner?: boolean;
}): boolean {
  return (
    (session.roles?.includes("admin") ?? session.role === "admin") ||
    Boolean(session.isOwner)
  );
}

export async function fetchFingerprintAltAccounts(input: unknown): Promise<
  ServerActionResult<{
    accounts: FingerprintAltAccount[];
    canBulkBan: boolean;
  }>
> {
  const session = await requirePageAccess("/users");
  const parsed = z.string().trim().min(1).max(100).safeParse(input);
  if (!parsed.success) return fail("Invalid user ID.", "VALIDATION");

  try {
    return ok({
      accounts: await getFingerprintAltAccounts(parsed.data),
      canBulkBan: isBulkBanAuthorized(session),
    });
  } catch (err) {
    logError("users.fingerprintAlts", "linked-account lookup failed", err);
    return fail("Couldn't load the fingerprint-linked accounts.");
  }
}

const banFingerprintAltsSchema = z.object({
  sourceUserId: z.string().trim().min(1).max(100),
  userIds: z.array(z.string().trim().min(1).max(100)).min(1).max(250),
});

/** Ban a reviewed subset of accounts that are still linked to the source. */
export async function banFingerprintAltAccounts(
  input: unknown,
): Promise<
  ServerActionResult<{
    bannedCount: number;
    failed: Array<{ userId: string; error: string }>;
  }>
> {
  const session = await requirePageAccess("/users");
  if (!isBulkBanAuthorized(session)) {
    return fail("Bulk ban is restricted to admins and owners.", "FORBIDDEN");
  }

  const parsed = banFingerprintAltsSchema.safeParse(input);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid selection.", "VALIDATION");
  }
  const requestedIds = [...new Set(parsed.data.userIds)];

  let liveAccounts: FingerprintAltAccount[];
  try {
    liveAccounts = await getFingerprintAltAccounts(parsed.data.sourceUserId);
  } catch (err) {
    logError("users.fingerprintAlts.ban", "validation lookup failed", err);
    return fail("Couldn't re-check the linked accounts. Nothing was banned.");
  }

  const liveById = new Map(liveAccounts.map((account) => [account.id, account]));
  const invalid = requestedIds.filter((id) => !liveById.get(id)?.canBan);
  if (invalid.length > 0) {
    return fail(
      "The linked-account set or protection state changed. Review the list again.",
      "CONFLICT",
    );
  }

  let bannedCount = 0;
  const failed: Array<{ userId: string; error: string }> = [];
  for (const userId of requestedIds) {
    const result = await banUser(
      userId,
      `Multi — shared IP or device identity with ${parsed.data.sourceUserId}`,
    );
    if (result.success) bannedCount += 1;
    else failed.push({ userId, error: result.error });
  }

  return ok({ bannedCount, failed });
}

/**
 * How many accounts a criteria set would ban, WITHOUT banning anything.
 *
 * Powers the dialog's live preview. Resolves through the exact same
 * `getUserIdsMatchingFilters` the ban itself uses — so the number shown is
 * the number acted on, not an approximation from a different query.
 */
export async function previewBulkBanCount(filters: {
  role?: string;
  status?: string;
  deposited?: string;
  provider?: string;
  sharedIp?: string;
  sharedDevice?: string;
  freeOnly?: string;
}): Promise<ServerActionResult<{ count: number; capped: boolean }>> {
  const session = await requirePageAccess("/users");
  if (!isBulkBanAuthorized(session)) {
    return fail("Bulk ban is restricted to admins and owners.", "FORBIDDEN");
  }
  if (!Object.values(filters).some((v) => !!v)) {
    return fail("Select at least one criterion.", "VALIDATION");
  }
  try {
    const ids = await getUserIdsMatchingFilters(filters);
    return ok({
      count: Math.min(ids.length, BULK_BAN_MAX),
      capped: ids.length > BULK_BAN_MAX,
    });
  } catch (err) {
    logError("users.bulkBanPreview", "preview count failed", err);
    return fail("Couldn't count the matching accounts — please try again.");
  }
}

/**
 * Bulk-ban every user matching a set of /users list filters.
 *
 * Stricter than {@link banUser} on purpose: single bans are a support
 * capability (`__can_ban_users` sits in the support baseline), but a bulk ban
 * can restructure the user base in one click, so this is ADMIN/OWNER ONLY.
 *
 * There is deliberately NO bulk delete. Deleting would orphan
 * `ledger_transactions` (money history), break the hash-chained audit trail,
 * and null out `fingerprints.user_id` — destroying the very alt-detection
 * evidence that justifies the ban. Banning is reversible and keeps all of it.
 *
 * Safety rails, in order:
 *   1. admin/owner only, re-checked server-side (not a render gate)
 *   2. a non-empty reason is required — it becomes the cohort marker
 *   3. `expectedCount` must match what the server independently resolves;
 *      a moving target aborts rather than banning a different population
 *   4. BULK_BAN_MAX ceiling on blast radius
 *   5. the resolver excludes already-banned accounts, every role except
 *      plain `user` (admin / support / creator), and ex-creators — anyone
 *      with a creator artifact in either DB, whatever their role is now
 *      (owner rule 2026-07-24: "never ever ban ex creators")
 */
export async function bulkBanFilteredUsers(input: {
  filters: {
    role?: string;
    status?: string;
    deposited?: string;
    provider?: string;
    sharedIp?: string;
    sharedDevice?: string;
    freeOnly?: string;
    affiliateCode?: string;
    affiliateOwnerId?: string;
  };
  reason: string;
  expectedCount: number;
}): Promise<ServerActionResult<{ bannedCount: number }>> {
  const session = await requirePageAccess("/users");

  // Admin OR owner. Re-verified here because the button's visibility is a
  // render gate, and a render gate is not a security boundary.
  if (!isBulkBanAuthorized(session)) {
    return fail("Bulk ban is restricted to admins and owners.", "FORBIDDEN");
  }

  const reason = input.reason?.trim();
  if (!reason) {
    return fail("A ban reason is required.", "VALIDATION");
  }

  // At least one filter — an empty filter set would match the entire
  // customer base, which is never a thing anyone means to do.
  const hasFilter = Object.values(input.filters).some((v) => !!v);
  if (!hasFilter) {
    return fail(
      "Select at least one filter — refusing to ban an unfiltered list.",
      "VALIDATION",
    );
  }

  let userIds: string[];
  try {
    userIds = await getUserIdsMatchingFilters(input.filters);
  } catch (err) {
    logError("users.bulkBan", "failed to resolve matching users", err);
    return fail("Couldn't resolve the matching users — please try again.");
  }

  if (userIds.length > BULK_BAN_MAX) {
    return fail(
      `That filter matches more than ${BULK_BAN_MAX.toLocaleString()} accounts. Narrow it down.`,
      "VALIDATION",
    );
  }
  if (userIds.length === 0) {
    return fail("No accounts match that filter.", "VALIDATION");
  }
  // The count the operator confirmed must still be the count we found. If
  // signups landed (or someone else banned) between preview and confirm, stop.
  if (userIds.length !== input.expectedCount) {
    return fail(
      `The matching set changed (${input.expectedCount.toLocaleString()} → ${userIds.length.toLocaleString()}). Re-check the filter and try again.`,
      "CONFLICT",
    );
  }

  const db = await getPrimaryDrizzleDb();
  const issuerMainUserId = await resolveAdminMainUserId(session.userId);
  const bannedAt = new Date();

  // Chunked so one statement never carries 25k ids.
  const CHUNK = 1_000;
  let bannedCount = 0;
  try {
    for (let i = 0; i < userIds.length; i += CHUNK) {
      const chunk = userIds.slice(i, i + CHUNK);
      bannedCount += await db.transaction(async (tx) => {
        const updated = await tx.execute<{ id: string }>(sql`
          UPDATE "user"
          SET is_banned = TRUE, banned_reason = ${reason},
              banned_at = ${bannedAt}, banned_by = ${issuerMainUserId},
              updated_at = NOW()
          WHERE id = ANY(${pgArrayParam(chunk)}::text[]) AND is_banned = FALSE
          RETURNING id
        `);
        await tx.execute(sql`DELETE FROM session WHERE "userId" = ANY(${pgArrayParam(chunk)}::text[])`);
        return updated.rows.length;
      });
    }
  } catch (err) {
    logError("users.bulkBan", "bulk ban transaction failed", err);
    // Partial progress is possible across chunks — report it rather than
    // implying nothing happened.
    return fail(
      `Ban failed after ${bannedCount.toLocaleString()} accounts. Re-run to finish the rest.`,
    );
  }

  // ONE audit event carrying the full id list, so the action is completely
  // reconstructable (and reversible) from the trail without 25k rows.
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "accounts_bulk_banned",
    metadata: {
      reason,
      filters: input.filters,
      requested: userIds.length,
      banned: bannedCount,
      issuer_main_user_id: issuerMainUserId,
      user_ids: userIds,
    },
  });

  revalidateTag("users-list");
  revalidateTag("users-list-stats");
  return ok({ bannedCount });
}

/** How many matched accounts the unban preview lists by name. */
const UNBAN_PREVIEW_SAMPLE = 25;

/**
 * How many per-user ban details the audit event keeps verbatim. An unban
 * NULLs `banned_reason` / `banned_at` / `banned_by`, so the audit row is
 * the only surviving record of why each account was banned — but a 25k-row
 * sweep would make the metadata absurd. Beyond this the event keeps the
 * full id list plus a complete reason histogram and flags itself truncated,
 * rather than pretending it captured everything.
 */
const UNBAN_AUDIT_DETAIL_MAX = 2_000;

/**
 * Who a set of unban criteria would release, WITHOUT releasing anyone.
 *
 * Returns a count plus a named sample, because this dialog exists to
 * RE-CHECK bans — a bare number can't tell the operator whether the filter
 * found the cohort they meant. Resolves through the exact same
 * `getBannedUserIdsMatchingFilters` the unban itself uses.
 */
export async function previewBulkUnban(
  filters: BulkUnbanFilters,
): Promise<
  ServerActionResult<{
    count: number;
    capped: boolean;
    sample: BulkUnbanPreviewUser[];
  }>
> {
  const session = await requirePageAccess("/users");
  if (!isBulkBanAuthorized(session)) {
    return fail("Bulk unban is restricted to admins and owners.", "FORBIDDEN");
  }
  if (!Object.values(filters).some((v) => v !== undefined && v !== "")) {
    return fail("Select at least one criterion.", "VALIDATION");
  }
  try {
    const ids = await getBannedUserIdsMatchingFilters(filters);
    return ok({
      count: Math.min(ids.length, BULK_BAN_MAX),
      capped: ids.length > BULK_BAN_MAX,
      sample: await getBulkUnbanPreviewUsers(ids, UNBAN_PREVIEW_SAMPLE),
    });
  } catch (err) {
    logError("users.bulkUnbanPreview", "preview failed", err);
    return fail("Couldn't count the matching accounts — please try again.");
  }
}

/**
 * Bulk-unban every BANNED user matching a set of criteria — the counterpart
 * to {@link bulkBanFilteredUsers}, and the way out of a bad sweep.
 *
 * It exists because the bulk ban shipped before the creator carve-out did.
 * A sweep run in that window could have taken out creators and ex-creators,
 * and picking them back out one at a time isn't realistic. `accountType:
 * "protected"` finds exactly that population: every banned account today's
 * ban rules would refuse to touch.
 *
 * Same rails as the ban, for the same reason — this restores site access to
 * accounts someone deliberately removed it from, so it is not a "safe
 * because it's reversible" action:
 *   1. admin/owner only, re-checked server-side
 *   2. at least one criterion — no unfiltered mass release
 *   3. `expectedCount` must match what the server independently resolves
 *   4. BULK_BAN_MAX ceiling on blast radius
 *
 * The prior ban state is snapshotted into the audit event BEFORE the write,
 * because unbanning NULLs `banned_reason` / `banned_at` / `banned_by` — the
 * audit row is what makes a mistaken unban re-doable.
 */
export async function bulkUnbanFilteredUsers(input: {
  filters: BulkUnbanFilters;
  note?: string;
  expectedCount: number;
}): Promise<ServerActionResult<{ unbannedCount: number }>> {
  const session = await requirePageAccess("/users");

  if (!isBulkBanAuthorized(session)) {
    return fail("Bulk unban is restricted to admins and owners.", "FORBIDDEN");
  }

  const hasFilter = Object.values(input.filters).some(
    (v) => v !== undefined && v !== "",
  );
  if (!hasFilter) {
    return fail(
      "Select at least one filter — refusing to unban an unfiltered list.",
      "VALIDATION",
    );
  }

  let userIds: string[];
  try {
    userIds = await getBannedUserIdsMatchingFilters(input.filters);
  } catch (err) {
    logError("users.bulkUnban", "failed to resolve matching users", err);
    return fail("Couldn't resolve the matching users — please try again.");
  }

  if (userIds.length > BULK_BAN_MAX) {
    return fail(
      `That filter matches more than ${BULK_BAN_MAX.toLocaleString()} accounts. Narrow it down.`,
      "VALIDATION",
    );
  }
  if (userIds.length === 0) {
    return fail("No banned accounts match that filter.", "VALIDATION");
  }
  if (userIds.length !== input.expectedCount) {
    return fail(
      `The matching set changed (${input.expectedCount.toLocaleString()} → ${userIds.length.toLocaleString()}). Re-check the filter and try again.`,
      "CONFLICT",
    );
  }

  const db = await getPrimaryDrizzleDb();

  // Snapshot BEFORE the write — the unban destroys these three columns and
  // this is the only place they survive.
  let priorState: Array<{
    id: string;
    username: string | null;
    banned_reason: string | null;
    banned_at: Date | string | null;
  }>;
  try {
    priorState = (
      await db.execute<{
        id: string;
        username: string | null;
        banned_reason: string | null;
        banned_at: Date | string | null;
      }>(sql`
        SELECT id, username, banned_reason, banned_at
        FROM "user"
        WHERE id = ANY(${pgArrayParam(userIds)}::text[])
      `)
    ).rows;
  } catch (err) {
    logError("users.bulkUnban", "failed to snapshot prior ban state", err);
    return fail("Couldn't read the current ban state — please try again.");
  }

  const reasonHistogram: Record<string, number> = {};
  for (const u of priorState) {
    const key = u.banned_reason ?? "(no reason recorded)";
    reasonHistogram[key] = (reasonHistogram[key] ?? 0) + 1;
  }

  const note = input.note?.trim() || null;
  const CHUNK = 1_000;
  let unbannedCount = 0;
  try {
    for (let i = 0; i < userIds.length; i += CHUNK) {
      const chunk = userIds.slice(i, i + CHUNK);
      const updated = await db.execute<{ id: string }>(sql`
        UPDATE "user"
        SET is_banned = FALSE, banned_reason = NULL, banned_at = NULL,
            banned_by = NULL, updated_at = NOW()
        WHERE id = ANY(${pgArrayParam(chunk)}::text[]) AND is_banned = TRUE
        RETURNING id
      `);
      unbannedCount += updated.rows.length;
    }
  } catch (err) {
    logError("users.bulkUnban", "bulk unban failed", err);
    // Chunked, so partial progress is real — report it instead of
    // implying nothing happened.
    return fail(
      `Unban failed after ${unbannedCount.toLocaleString()} accounts. Re-run to finish the rest.`,
    );
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "accounts_bulk_unbanned",
    metadata: {
      note,
      filters: input.filters,
      requested: userIds.length,
      unbanned: unbannedCount,
      user_ids: userIds,
      // Complete regardless of size — the per-user detail below is not.
      prior_ban_reasons: reasonHistogram,
      prior_ban_detail_truncated: priorState.length > UNBAN_AUDIT_DETAIL_MAX,
      prior_ban_detail: priorState
        .slice(0, UNBAN_AUDIT_DETAIL_MAX)
        .map((u) => ({
          id: u.id,
          username: u.username,
          reason: u.banned_reason,
          banned_at: u.banned_at
            ? new Date(u.banned_at).toISOString()
            : null,
        })),
    },
  });

  revalidateTag("users-list");
  revalidateTag("users-list-stats");
  return ok({ unbannedCount });
}
