import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";

export type DiscordCasinoCatalogSite = {
  slug: string;
  name: string;
  aliases: string[];
  domains: string[];
  tokensPerUsd: number | null;
};

export async function getDiscordCasinoCatalog(): Promise<{
  version: 1;
  sites: DiscordCasinoCatalogSite[];
}> {
  const result = await adminDrizzle.execute<{
    slug: string;
    display_name: string;
    tokens_per_usd: string | null;
    aliases: string[];
    domains: string[];
  }>(sql`
    SELECT
      site.slug,
      site.display_name,
      site.tokens_per_usd::text,
      COALESCE(
        array_agg(DISTINCT alias.alias ORDER BY alias.alias)
          FILTER (WHERE alias.alias IS NOT NULL),
        ARRAY[]::text[]
      ) AS aliases,
      COALESCE(
        array_agg(DISTINCT domain.domain ORDER BY domain.domain)
          FILTER (WHERE domain.domain IS NOT NULL),
        ARRAY[]::text[]
      ) AS domains
    FROM casino_sites AS site
    LEFT JOIN casino_site_aliases AS alias ON alias.site_id = site.id
    LEFT JOIN casino_site_domains AS domain ON domain.site_id = site.id
    WHERE site.active = true
    GROUP BY site.id
    ORDER BY site.display_name, site.slug
    LIMIT 250
  `);

  return {
    version: 1,
    sites: result.rows.map((row) => {
      const tokensPerUsd = row.tokens_per_usd === null
        ? null
        : Number(row.tokens_per_usd);
      if (tokensPerUsd !== null && (!Number.isFinite(tokensPerUsd) || tokensPerUsd <= 0)) {
        throw new Error(`Casino catalog has an invalid conversion rate for ${row.slug}.`);
      }
      return {
        slug: row.slug,
        name: row.display_name,
        aliases: row.aliases,
        domains: row.domains,
        tokensPerUsd,
      };
    }),
  };
}
