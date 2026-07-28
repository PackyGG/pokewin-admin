/**
 * Multi-host routing for the dashboard.
 *
 * One deployment, one build, one session — served under several hostnames, each
 * of which presents a different part of the app at its root:
 *
 *   packydash.com            → the main admin dashboard      (lands /dashboard)
 *   packs.packydash.com      → Pack Studio                   (lands /pack-studio)
 *   fraud.packydash.com      → the Antifraud workspace       (lands /antifraud)
 *   marketing.packydash.com  → the Creator Hub               (lands /creator-hub)
 *
 * TWO KINDS OF HOST, and the distinction is the whole design:
 *
 *   • SEGMENT hosts (`basePath` set) REWRITE into a route segment, so
 *     `packs.packydash.com/doctor` renders `/pack-studio/doctor`. The sub-app
 *     owns the whole hostname and its URLs are clean.
 *
 *   • LANDING hosts (`basePath` null) don't rewrite anything — they serve the
 *     app at its canonical paths and only decide where `/` goes. The apex is
 *     the landing host: it serves the main admin app at canonical paths.
 *
 * CROSS-APP LINKS: because a segment host rewrites unknown paths into its own
 * tree, a bare `/dashboard` link would resolve to `/pack-studio/dashboard` and
 * 404. Every link that crosses an app boundary therefore has to be an ABSOLUTE
 * URL to the owning host — see {@link crossAppHrefs}, which the layouts compute
 * server-side and hand to the sidebars. The middleware additionally redirects a
 * known sub-app path that lands on the wrong host, so a stale bookmark
 * self-heals instead of 404ing.
 *
 * IMPORTED BY MIDDLEWARE — must stay dependency-free and Edge-safe. No node
 * imports, no DB, no `server-only`.
 *
 * Nothing here activates until a hostname actually resolves to this deployment:
 * an unmatched `Host` falls through completely untouched, which is why this
 * ships safely before the DNS exists.
 */

/** The registrable domain every dashboard host sits under. */
export const ROOT_DOMAIN = "packydash.com";

export type AppHostKind = "segment" | "landing";

export type AppHostConfig = {
  /** Hostname, lowercase, no port. */
  host: string;
  /**
   * Route segment this host serves at its root, or null for a host that serves
   * the app at canonical paths and only picks a landing page.
   */
  basePath: string | null;
  /**
   * The sub-app's own top-level routes, WITHOUT the base path. This is what
   * makes the rewrite unambiguous: on a segment host `/doctor` is a Pack Studio
   * page and `/dashboard` is a main-app page, and only an explicit list can
   * tell them apart. A path whose first segment isn't here is treated as a
   * main-app path and redirected to the apex instead of being rewritten into a
   * route that doesn't exist.
   *
   * Empty for landing hosts (they never rewrite).
   */
  segmentRoutes: readonly string[];
  /** Where `/` resolves to for an authenticated viewer. */
  landing: string;
  label: string;
  /**
   * Which effective roles may use this front door. `null` = everyone with an
   * account.
   *
   * IMPORTANT — this is a ROUTING convenience, not the security boundary. It
   * runs in middleware off the signed JWT, so it can't see the ADMIN-DB access
   * toggles or per-username allowlists. The authoritative gate is unchanged and
   * still runs in each sub-app's layout (`canAccessPackStudio`,
   * `canAccessAntifraud`) against fresh DB state. This only stops someone
   * landing on a door that clearly isn't theirs, and it deliberately FAILS OPEN
   * (lets the layout decide) for anything it can't determine.
   */
  allowRoles: readonly string[] | null;
};

/**
 * Every sub-app that owns a route segment. Used both for the host map below and
 * for the middleware's wrong-host redirect, so the two can never disagree.
 */
export const SEGMENT_BASE_PATHS = [
  "/pack-studio",
  "/antifraud",
  "/creator-hub",
] as const;

/**
 * Retired public prefixes. These still resolve so old bookmarks self-heal, but
 * the canonical URL always uses the owning subdomain without the prefix.
 */
const HOST_PATH_ALIASES = [
  { prefix: "/marketing", host: `marketing.${ROOT_DOMAIN}` },
] as const;

export const APP_HOSTS: readonly AppHostConfig[] = [
  {
    host: ROOT_DOMAIN,
    basePath: null,
    segmentRoutes: [],
    landing: "/dashboard",
    label: "Admin Dashboard",
    // The main door. Everyone with an account lands here; what they can SEE is
    // decided per page by the existing permission model, unchanged.
    allowRoles: null,
  },
  {
    // Vercel redirects www → apex, but matching it here too means a request
    // that slips through still behaves rather than falling to the default.
    host: `www.${ROOT_DOMAIN}`,
    basePath: null,
    segmentRoutes: [],
    landing: "/dashboard",
    label: "Admin Dashboard",
    allowRoles: null,
  },
  {
    host: `packs.${ROOT_DOMAIN}`,
    basePath: "/pack-studio",
    segmentRoutes: [
      "packs",
      "cards",
      "doctor",
      "retune",
      "builder",
      "builder-drafts",
      "new-packs",
      "drafts",
      "history",
    ],
    landing: "/pack-studio",
    label: "Pack Studio",
    // Mirrors the role half of `canAccessPackStudio` (admins in by default).
    // `pack_creator` is here because building packs is literally that role's
    // job. Owners bypass this separately. A per-username allowlisted account
    // that ISN'T one of these roles still gets in — see `isAllowedOnHost`,
    // which fails open so only the DB-accurate layout gate can actually deny.
    allowRoles: ["admin", "pack_creator"],
  },
  {
    host: `fraud.${ROOT_DOMAIN}`,
    basePath: "/antifraud",
    segmentRoutes: [
      "api",
      "monitor",
      "withdrawals",
      "fiat-deposits",
      "points",
      "flows",
      "events",
      "email-blacklist",
      "risky-locations",
      "reviews",
      "kyc",
      "signups",
      "networks",
      "creator-fraud",
      "quizzes",
      "staff",
      "profile",
      "notifications",
      "settings",
    ],
    landing: "/antifraud",
    label: "Antifraud",
    // Mirrors the role half of `canAccessAntifraud`: admins plus the roles
    // whose ADMIN-DB toggle can be switched on (support is on today).
    allowRoles: ["admin", "support", "marketing", "creator_manager"],
  },
  {
    // The Creator Hub — the creator/marketing team's workspace — owns this
    // hostname as a SEGMENT host, so marketing.packydash.com/creators renders
    // /creator-hub/creators with a clean URL, exactly like packs./fraud.
    host: `marketing.${ROOT_DOMAIN}`,
    basePath: "/creator-hub",
    segmentRoutes: [
      "creators",
      "leaderboards",
      "tips-sponsors",
      "rewards",
      "socials-review",
      "profitability",
      "profitable-algo",
    ],
    landing: "/creator-hub",
    label: "Creator Hub",
    // Mirrors the role half of `canAccessCreatorHub`: the per-role Hub
    // toggles exist for admin + creator_manager. `marketing` stays listed so
    // the old marketing front door doesn't hard-bounce that team at the
    // routing layer — the DB-fresh layout gate (`canAccessCreatorHub`) is
    // still the real boundary and decides who actually gets in.
    allowRoles: ["admin", "creator_manager", "marketing"],
  },
];

/**
 * Paths that must NEVER be rewritten onto a segment, even on a segment host:
 *
 *   • `/api/*`, `/_next/*`, static assets — infrastructure, host-agnostic.
 *   • the auth routes — someone landing on packs.packydash.com while logged out
 *     is sent to `/login`, and that page has to render as itself, not as
 *     `/pack-studio/login` (which doesn't exist).
 */
const PASSTHROUGH_PREFIXES = [
  "/api/",
  "/_next/",
  "/login",
  "/verify-2fa",
  "/setup-2fa",
  "/monitoring",
];

const PASSTHROUGH_EXACT = new Set(["/favicon.ico", "/robots.txt"]);

/** Strip the port and normalize, so `fraud.localhost:3000` matches cleanly. */
export function normalizeHost(host: string | null | undefined): string {
  if (!host) return "";
  return host.split(":")[0].trim().toLowerCase();
}

/**
 * Extra hostnames, mapped onto an existing config by label. Lets a preview
 * domain or a local `fraud.localhost` behave like the real host without a code
 * change. Format: `host=basePathOrRoot`, comma-separated. e.g.
 * `fraud.localhost=/antifraud,packs.localhost=/pack-studio`
 */
function extraHosts(): AppHostConfig[] {
  const raw = process.env.NEXT_PUBLIC_APP_HOST_MAP ?? "";
  if (!raw.trim()) return [];
  const out: AppHostConfig[] = [];
  for (const entry of raw.split(",")) {
    const [rawHost, rawBase] = entry.split("=");
    const host = normalizeHost(rawHost);
    if (!host) continue;
    const base = (rawBase ?? "").trim();
    const known = APP_HOSTS.find((h) => h.basePath === base);
    out.push({
      host,
      basePath: base && base !== "/" ? base : null,
      segmentRoutes: known?.segmentRoutes ?? [],
      landing: known?.landing ?? (base && base !== "/" ? base : "/dashboard"),
      label: known?.label ?? host,
      allowRoles: known?.allowRoles ?? null,
    });
  }
  return out;
}

/** Resolve a `Host` header to its config, or null when it isn't one of ours. */
export function resolveAppHost(
  host: string | null | undefined,
): AppHostConfig | null {
  const hostname = normalizeHost(host);
  if (!hostname) return null;
  return (
    APP_HOSTS.find((h) => h.host === hostname) ??
    extraHosts().find((h) => h.host === hostname) ??
    null
  );
}

/** The config that owns a given route segment, if any. */
export function hostForBasePath(basePath: string): AppHostConfig | null {
  return APP_HOSTS.find((h) => h.basePath === basePath) ?? null;
}

type OwnedPublicPath = {
  owner: AppHostConfig;
  publicPath: string;
};

function pathAfterPrefix(pathname: string, prefix: string): string | null {
  if (pathname === prefix) return "/";
  if (!pathname.startsWith(prefix + "/")) return null;
  return pathname.slice(prefix.length);
}

/**
 * Resolve an internal or retired prefixed path to the host and clean path users
 * should see. Middleware redirects and link generation share this function so
 * links cannot reintroduce a prefix that routing removes.
 */
function ownedPublicPath(pathname: string): OwnedPublicPath | null {
  for (const basePath of SEGMENT_BASE_PATHS) {
    const publicPath = pathAfterPrefix(pathname, basePath);
    if (publicPath === null) continue;
    const owner = hostForBasePath(basePath);
    if (!owner) return null;
    return { owner, publicPath };
  }

  for (const alias of HOST_PATH_ALIASES) {
    const publicPath = pathAfterPrefix(pathname, alias.prefix);
    if (publicPath === null) continue;
    const owner = APP_HOSTS.find((entry) => entry.host === alias.host);
    if (!owner) return null;
    return {
      owner,
      publicPath:
        publicPath === "/" && !owner.basePath ? owner.landing : publicPath,
    };
  }

  return null;
}

function isPassthrough(pathname: string): boolean {
  if (PASSTHROUGH_EXACT.has(pathname)) return true;
  if (PASSTHROUGH_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  // Anything with a file extension is an asset — leave it alone.
  return /\.[a-z0-9]+$/i.test(pathname);
}

/**
 * The internal path a request should render, or `null` to pass through
 * untouched.
 *
 *   packs host, "/"        → "/pack-studio"
 *   packs host, "/doctor"  → "/pack-studio/doctor"
 *   packs host, "/pack-studio/doctor" → null (already correct)
 *   any host,   "/login"   → null (passthrough)
 *   landing host, anything → null (landing hosts never rewrite)
 */
export function rewritePathForHost(
  config: AppHostConfig,
  pathname: string,
): string | null {
  if (!config.basePath) return null;
  if (isPassthrough(pathname)) return null;
  // Already inside this host's internal segment. The redirect layer
  // canonicalizes this to the clean public path before it reaches here.
  if (
    pathname === config.basePath ||
    pathname.startsWith(config.basePath + "/")
  ) {
    return null;
  }
  if (pathname === "/") return config.basePath;

  // ONLY rewrite paths this sub-app actually owns. Without the explicit list,
  // `/dashboard` on packs.packydash.com would become `/pack-studio/dashboard`
  // and 404; with it, an unknown first segment is recognised as a main-app path
  // and redirected to the apex instead (see `redirectTargetForHost`).
  const first = pathname.split("/")[1] ?? "";
  if (!config.segmentRoutes.includes(first)) return null;

  return config.basePath + pathname;
}

/**
 * The absolute URL a request should be redirected to, or null to handle it
 * locally. Two jobs, both about keeping ONE canonical home per app:
 *
 *  1. A prefixed path goes to its owner with the prefix stripped. This applies
 *     even when it is already on the right host, so old links and bookmarks
 *     cannot leave `/antifraud`, `/pack-studio`, or `/marketing` in
 *     the visible URL.
 *
 *  2. On a SEGMENT host, a path that isn't one of this sub-app's own routes is
 *     a main-app path and goes to the apex. This is what makes an un-upgraded
 *     `/dashboard` link work from inside Pack Studio or Antifraud.
 */
export function redirectTargetForHost(
  config: AppHostConfig,
  pathname: string,
): string | null {
  if (isPassthrough(pathname)) return null;

  // (1) Prefixed path with a dedicated host? Always redirect to its clean
  // public path, including when the request is already on that host.
  const owned = ownedPublicPath(pathname);
  if (owned) {
    return `https://${owned.owner.host}${owned.publicPath}`;
  }

  // (2) A main-app path on a segment host.
  if (config.basePath && pathname !== "/") {
    const first = pathname.split("/")[1] ?? "";
    if (!config.segmentRoutes.includes(first)) {
      return `https://${APP_HOSTS[0].host}${pathname}`;
    }
  }

  return null;
}

/**
 * Whether a session may use this host's front door.
 *
 * FAILS OPEN by design. This runs in middleware against the signed JWT, which
 * knows roles but NOT the ADMIN-DB access toggles or per-username allowlists —
 * so it can only recognise someone who clearly belongs. Anything it can't
 * determine is allowed through to the sub-app's real gate
 * (`canAccessPackStudio` / `canAccessAntifraud`), which reads fresh DB state
 * and is the actual security boundary. The cost of that choice is one extra
 * redirect for an edge case; the cost of failing closed would be locking out a
 * legitimately allowlisted account, which is worse and harder to debug.
 */
export function isAllowedOnHost(
  config: AppHostConfig,
  session: {
    role?: string | null;
    roles?: readonly string[] | null;
    username?: string | null;
    isOwner?: boolean;
  } | null,
): boolean {
  if (!config.allowRoles) return true;
  if (!session) return true; // unauthenticated → the auth redirect handles it

  // Owners bypass every door. The root owner is recognised by username so the
  // check never depends on a flag the JWT might not carry.
  if (session.isOwner === true) return true;
  if ((session.username ?? "").trim().toLowerCase() === "motha") return true;

  const roles = new Set<string>();
  if (session.role) roles.add(session.role);
  for (const role of session.roles ?? []) roles.add(role);
  // No roles on the token at all → can't judge; let the layout decide.
  if (roles.size === 0) return true;

  return config.allowRoles.some((role) => roles.has(role));
}

/**
 * Absolute-or-relative href for `path`, as seen FROM `current`.
 *
 * Returns a plain path when the target is served by the current host (so
 * client-side navigation stays a soft transition), and a fully-qualified URL
 * when it crosses to another host. Passing `current: null` — the state before
 * any custom domain exists — always yields the plain path, which is exactly
 * today's single-host behaviour.
 */
export function hrefFrom(
  current: AppHostConfig | null,
  path: string,
): string {
  if (
    /^(?:https?:\/\/|mailto:|tel:|#|\?)/i.test(path)
  ) {
    return path;
  }
  if (!current) return path;

  // Which host owns this internal path, and what is its clean public path?
  const owned = ownedPublicPath(path);

  if (!owned) {
    // A main-app path. Reachable in place on a landing host; on a segment host
    // it has to be absolute, because a bare path would be rewritten into the
    // segment.
    if (!current.basePath) return path;
    const apex = APP_HOSTS[0];
    return `https://${apex.host}${path}`;
  }

  if (owned.owner.host === current.host) {
    return owned.publicPath;
  }

  return `https://${owned.owner.host}${owned.publicPath}`;
}

/** The href set every sidebar needs, resolved once server-side. */
export type CrossAppHrefs = {
  admin: string;
  packStudio: string;
  antifraud: string;
  creatorHub: string;
};

export function crossAppHrefs(current: AppHostConfig | null): CrossAppHrefs {
  return {
    admin: hrefFrom(current, "/dashboard"),
    packStudio: hrefFrom(current, "/pack-studio"),
    antifraud: hrefFrom(current, "/antifraud"),
    creatorHub: hrefFrom(current, "/creator-hub"),
  };
}

/**
 * Absolute origin for a sub-app, for links that leave the browser entirely
 * (Discord / Telegram pings). Falls back to the configured public URL, then
 * to null so callers can degrade to a bare path.
 */
export function absoluteOriginForBasePath(basePath: string): string | null {
  const owner = hostForBasePath(basePath);
  return owner ? `https://${owner.host}` : null;
}
