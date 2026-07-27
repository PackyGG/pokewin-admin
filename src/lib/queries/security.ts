import { sql } from "drizzle-orm";
import { getReadDrizzleDb } from "@/lib/db";

export type SiteConfigRow = {
  key: string;
  value: string;
  description: string | null;
};

export async function getSiteConfig(): Promise<SiteConfigRow[]> {
  const db = await getReadDrizzleDb();
  const result = await db.execute<SiteConfigRow>(sql`
    SELECT key, value, description
    FROM site_config
    ORDER BY key ASC
  `);

  return result.rows.map((r) => ({
    key: r.key,
    value: r.value,
    description: r.description,
  }));
}

export type VaultLockTimeRow = {
  id: string;
  hours: number;
  label: string;
};

/**
 * Vault lock windows — relocated read for the /security "Vault Lock Times"
 * section (the same MAIN-DB source the old `/settings` page used via
 * `getSettings`: `vault_lock_times` ordered by ascending hours). Read-only.
 */
export async function getVaultLockTimes(): Promise<VaultLockTimeRow[]> {
  const db = await getReadDrizzleDb();
  const result = await db.execute<VaultLockTimeRow>(sql`
    SELECT id, hours, label
    FROM vault_lock_times
    ORDER BY hours ASC
  `);

  return result.rows.map((v) => ({
    id: v.id,
    hours: v.hours,
    label: v.label,
  }));
}
