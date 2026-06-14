import { getDb } from "@/lib/db";

export type SiteConfigRow = {
  key: string;
  value: string;
  description: string | null;
};

export async function getSiteConfig(): Promise<SiteConfigRow[]> {
  const db = await getDb();
  const rows = await db.site_config.findMany({
    orderBy: { key: "asc" },
  });

  return rows.map((r) => ({
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
  const db = await getDb();
  const rows = await db.vault_lock_times.findMany({
    orderBy: { hours: "asc" },
  });

  return rows.map((v) => ({
    id: v.id,
    hours: v.hours,
    label: v.label,
  }));
}
