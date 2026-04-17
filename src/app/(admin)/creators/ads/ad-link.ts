/**
 * Shareable ad-link base. Reads `NEXT_PUBLIC_MAIN_SITE_URL` at build /
 * runtime so the same code works for production (packy.gg) and the
 * beta environment (beta.packy.gg). Falls back to production if the
 * env var isn't set so demos don't render a broken URL.
 *
 * Use on both server and client components — `NEXT_PUBLIC_` env vars are
 * inlined into the bundle by Next.js.
 */
export function getAdLink(code: string): string {
  const raw = process.env.NEXT_PUBLIC_MAIN_SITE_URL?.trim();
  // Strip trailing slash so we never emit `...//r/xyz`.
  const base = (raw && raw.length > 0 ? raw : "https://packy.gg").replace(
    /\/$/,
    "",
  );
  return `${base}/r/${code}`;
}
