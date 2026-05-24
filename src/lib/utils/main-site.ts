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

/** Live battle page on the public site: `<base>/games/battles/<id>`. */
export function battleUrl(battleId: string): string {
  return `${mainSiteBase()}/games/battles/${battleId}`;
}
