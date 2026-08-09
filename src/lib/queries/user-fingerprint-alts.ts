import "server-only";

import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getCreatorProtectedUserIds } from "@/lib/queries/creator-protected-ids";
import { calculateUsersPnlBatch } from "@/lib/queries/pnl";
import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";

export type FingerprintAltAccount = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  role: string;
  isBanned: boolean;
  totalDeposited: number;
  totalWagered: number;
  sharedDeviceCount: number;
  canBan: boolean;
  protectedReason: string | null;
};

type LinkedAccountRow = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  role: string;
  roles: string[] | null;
  is_banned: boolean;
  total_wagered: string | number | null;
  shared_device_count: string | number;
};

/**
 * Accounts sharing at least one Fingerprint visitor_id with `sourceUserId`.
 * The source account itself is deliberately excluded: this is the list of
 * *other* accounts the operator asked to identify.
 */
export async function getFingerprintAltAccounts(
  sourceUserId: string,
): Promise<FingerprintAltAccount[]> {
  const rows = await queryMainRows<LinkedAccountRow[]>(
    `
      WITH source_devices AS (
        SELECT DISTINCT visitor_id
          FROM fingerprints
         WHERE user_id = $1
      ), linked AS (
        SELECT f.user_id,
               COUNT(DISTINCT f.visitor_id)::int AS shared_device_count
          FROM fingerprints f
         WHERE f.user_id IS NOT NULL
           AND f.user_id <> $1
           AND f.visitor_id IN (SELECT visitor_id FROM source_devices)
         GROUP BY f.user_id
      )
      SELECT u.id, u.username, u.email, u.image, u.role::text AS role,
             u.roles::text[] AS roles, u.is_banned,
             COALESCE(b.total_wagered, 0)::text AS total_wagered,
             linked.shared_device_count
        FROM linked
        JOIN "user" u ON u.id = linked.user_id
        LEFT JOIN balances b ON b.user_id = u.id
       ORDER BY u.is_banned ASC, u.created_at ASC, u.id ASC
    `,
    sourceUserId,
  );

  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [pnlByUserId, creatorProtectedIds, excludedIds] = await Promise.all([
    calculateUsersPnlBatch(ids),
    getCreatorProtectedUserIds(),
    getExcludedUserIds(),
  ]);
  const creatorProtected = new Set(creatorProtectedIds);
  const excluded = new Set(excludedIds);
  const protectedRoles = new Set(["admin", "support", "creator"]);

  return rows.map((row) => {
    const hasProtectedRole =
      protectedRoles.has(row.role) ||
      (row.roles ?? []).some((role) => protectedRoles.has(role));
    const protectedReason = row.is_banned
      ? "Already banned"
      : hasProtectedRole
        ? "Staff or creator account"
        : creatorProtected.has(row.id)
          ? "Current or former creator"
          : excluded.has(row.id)
            ? "Protected analytics account"
            : null;

    return {
      id: row.id,
      username: row.username,
      email: row.email,
      image: row.image,
      role: row.role,
      isBanned: row.is_banned,
      totalDeposited: pnlByUserId.get(row.id)?.deposits ?? 0,
      totalWagered: toNumber(row.total_wagered),
      sharedDeviceCount: Number(row.shared_device_count),
      canBan: protectedReason === null,
      protectedReason,
    };
  });
}
