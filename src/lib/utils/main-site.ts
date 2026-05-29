/**
 * Public packy.gg site URL helpers. Reads `NEXT_PUBLIC_MAIN_SITE_URL` so
 * the same code points at production (packy.gg) or the beta environment
 * (beta.packy.gg), falling back to production when the var isn't set.
 * `NEXT_PUBLIC_` vars are inlined by Next.js, so these work on both server
 * and client components.
 */
export function mainSiteBase(): string {
  const raw = process.env.NEXT_PUBLIC_MAIN_SITE_URL?.trim();
  // Strip trailing slash(es) so we never emit a double slash.
  return (raw && raw.length > 0 ? raw : "https://packy.gg").replace(/\/+$/, "");
}

/**
 * Live battle page on the public site: `<base>/battle/<id>` (singular,
 * no `/games/` prefix). The previous helper emitted
 * `/games/battles/<id>` which 404'd on packy.gg — the "Watch" button on
 * the user-detail Gaming tab and the transaction-detail modal both go
 * through this helper, so any drift here breaks both surfaces.
 */
export function battleUrl(battleId: string): string {
  return `${mainSiteBase()}/battle/${battleId}`;
}
