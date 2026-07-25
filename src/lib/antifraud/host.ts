/**
 * Host-based routing for the Antifraud sub-app.
 *
 * The workspace lives at `/antifraud/*` in this app AND will additionally be
 * served from its own hostname, `fraud.packydash.com`, once the DNS record +
 * Vercel domain exist. Rather than fork a second deployment, the middleware
 * REWRITES requests arriving on the antifraud host into the `/antifraud` route
 * segment — so `fraud.packydash.com/reviews` renders exactly the same React
 * tree as `packydash.com/antifraud/reviews`, from one build, one session and
 * one database.
 *
 * Nothing here activates until the host actually resolves to this deployment:
 * a request whose `Host` header doesn't match simply falls through untouched,
 * which is why this can ship (and be reviewed) before the domain is bought.
 *
 * IMPORTED BY MIDDLEWARE — must stay dependency-free and Edge-safe. No node
 * imports, no DB, no `server-only`.
 */

/**
 * The canonical antifraud hostname. Additional hosts (preview domains, a
 * staging alias, `fraud.localhost:3000` for local work) can be added via the
 * comma-separated `NEXT_PUBLIC_ANTIFRAUD_HOSTS` env var without a code change.
 */
export const DEFAULT_ANTIFRAUD_HOST = "fraud.packydash.com";

/** The route segment every antifraud page lives under. */
export const ANTIFRAUD_BASE_PATH = "/antifraud";

/**
 * Paths that must NEVER be rewritten onto the antifraud segment, even on the
 * antifraud host:
 *
 *   • `/api/*`, `/_next/*`, and static assets — infrastructure, host-agnostic.
 *   • the auth routes — a staff member landing on fraud.packydash.com while
 *     logged out is redirected to `/login` by the auth middleware, and that
 *     page has to render as itself, not as `/antifraud/login` (which doesn't
 *     exist). Same for the 2FA steps.
 *   • `/antifraud/*` itself — already in the right place; rewriting again would
 *     produce `/antifraud/antifraud/...`.
 */
const PASSTHROUGH_PREFIXES = [
  "/api/",
  "/_next/",
  "/login",
  "/verify-2fa",
  "/setup-2fa",
  "/monitoring",
  ANTIFRAUD_BASE_PATH,
];

const PASSTHROUGH_EXACT = new Set(["/api", "/favicon.ico", "/robots.txt"]);

/** Every hostname that should serve the Antifraud workspace at its root. */
export function antifraudHosts(): string[] {
  const configured = process.env.NEXT_PUBLIC_ANTIFRAUD_HOSTS ?? "";
  const hosts = configured
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.includes(DEFAULT_ANTIFRAUD_HOST)) {
    hosts.push(DEFAULT_ANTIFRAUD_HOST);
  }
  return hosts;
}

/**
 * True if this request's Host header belongs to the antifraud app. The port is
 * stripped so `fraud.localhost:3000` matches a configured `fraud.localhost`.
 */
export function isAntifraudHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const hostname = host.split(":")[0].trim().toLowerCase();
  if (!hostname) return false;
  return antifraudHosts().includes(hostname);
}

/**
 * The internal path a request on the antifraud host should render, or `null`
 * when it must pass through untouched.
 *
 *   "/"                → "/antifraud"
 *   "/reviews"         → "/antifraud/reviews"
 *   "/quizzes/abc"     → "/antifraud/quizzes/abc"
 *   "/login"           → null (passthrough)
 *   "/api/health"      → null (passthrough)
 *   "/antifraud/staff" → null (already correct)
 */
export function antifraudRewritePath(pathname: string): string | null {
  if (PASSTHROUGH_EXACT.has(pathname)) return null;
  if (PASSTHROUGH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }
  // A file request (anything with an extension) is an asset — leave it alone.
  if (/\.[a-z0-9]+$/i.test(pathname)) return null;

  if (pathname === "/") return ANTIFRAUD_BASE_PATH;
  return ANTIFRAUD_BASE_PATH + pathname;
}

/**
 * The absolute origin of the antifraud app, when one is configured — used to
 * build clickable links in Discord/Telegram pings. Falls back to `null` so
 * callers can degrade to the dashboard's own origin.
 */
export function antifraudOrigin(): string | null {
  const explicit = process.env.NEXT_PUBLIC_ANTIFRAUD_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  return null;
}
