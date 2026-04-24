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
