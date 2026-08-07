/**
 * Public packy.gg site URL helpers. Reads `NEXT_PUBLIC_MAIN_SITE_URL` so
 * the same code points at production (packy.gg) or the beta environment
 * (beta.packy.gg), falling back to production when the var isn't set.
 * `NEXT_PUBLIC_` vars are inlined by Next.js, so these work on both server
 * and client components.
 */
function mainSiteBase(): string {
  const raw = process.env.NEXT_PUBLIC_MAIN_SITE_URL?.trim();
  // Strip trailing slash(es) so we never emit a double slash.
  return (raw && raw.length > 0 ? raw : "https://packy.gg").replace(/\/+$/, "");
}

/**
 * Live battle page on the public site: `<base>/games/battles/<id>`
 * (owner-confirmed 2026-06-17 — packy.gg routing moved here; the old
 * `/battle/<id>` path is now wrong). The "Watch" button on the
 * user-detail Gaming tab and the transaction-detail modal both go
 * through this helper, so any drift here breaks both surfaces.
 */
export function battleUrl(battleId: string): string {
  return `${mainSiteBase()}/games/battles/${battleId}`;
}

/**
 * Pack page on the public site: `<base>/games/packs/<slug>`. The route
 * resolves either a slug or a pack id (frontend `/games/packs/[slug]` →
 * backend `GET /packs/{identifier}`), but the slug is the canonical form the
 * site itself links to, so prefer it and fall back to the id.
 */
export function packUrl(slugOrId: string): string {
  return `${mainSiteBase()}/games/packs/${encodeURIComponent(slugOrId)}`;
}

/** Absolute URL for any public-site path (`/races` → `https://packy.gg/races`). */
export function mainSiteUrl(path: string): string {
  return `${mainSiteBase()}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Public destinations an announcement can point at — used by the
 * /notifications composer's "Page" template ("new pages released etc.").
 * Verified against the live frontend nav (`navigation/nav-dropdown.tsx`,
 * `mobile-bottom-nav.tsx`, `footer.tsx`), not guessed.
 */
export const MAIN_SITE_PAGES: { label: string; path: string }[] = [
  { label: "Home", path: "/" },
  { label: "Packs", path: "/games/packs" },
  { label: "Battles", path: "/games/battles" },
  { label: "Upgrader", path: "/games/upgrader" },
  { label: "Races", path: "/races" },
  { label: "Raffles", path: "/raffles" },
  { label: "Rewards", path: "/rewards" },
  { label: "Inventory", path: "/inventory" },
  { label: "Collections", path: "/collections" },
  { label: "Exchange", path: "/exchange" },
  { label: "Affiliate", path: "/settings/affiliate" },
  { label: "Help center", path: "/help" },
];
