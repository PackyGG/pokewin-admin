import { NextRequest, NextResponse } from "next/server";
import { decrypt } from "@/lib/session";
import {
  APP_HOSTS,
  isAllowedOnHost,
  redirectTargetForHost,
  resolveAppHost,
  rewritePathForHost,
} from "@/lib/app-hosts";

const PUBLIC_ROUTES = ["/login"];
const PENDING_2FA_ROUTES = ["/verify-2fa", "/setup-2fa"];

// Role → landing page. Chat is a slide-out panel now, so support/marketing land
// on a real page. Used both for the post-login bounce and the legacy /chat
// bookmark redirect below.
const DEFAULT_ROUTE_BY_ROLE: Record<string, string> = {
  admin: "/dashboard",
  support: "/users",
  marketing: "/analytics",
};

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Multi-host routing ───────────────────────────────────────────────────
  // One deployment serves several hostnames, each fronting a different part of
  // the app (see src/lib/app-hosts.ts):
  //
  //   packydash.com           → main dashboard   (landing host, no rewrite)
  //   packs.packydash.com     → Pack Studio      (rewrites into /pack-studio)
  //   fraud.packydash.com     → Antifraud        (rewrites into /antifraud)
  //   marketing.packydash.com → marketing pages  (landing host, no rewrite)
  //
  // INERT until a hostname actually resolves here: an unmatched Host yields
  // `appHost === null` and every line below behaves exactly as it did on a
  // single domain. Auth still runs FIRST — the rewrite is only ever applied to
  // requests that would have been served anyway (`NextResponse.next()`), never
  // in place of a login redirect.
  const appHost = resolveAppHost(request.headers.get("host"));
  const rewriteTarget = appHost ? rewritePathForHost(appHost, pathname) : null;

  // Where this path really belongs, if not here. Two cases, both self-healing:
  // a path owned by another sub-app's host (an /antifraud link opened on
  // packs.packydash.com), and a main-app path on a segment host (the
  // "Back to Admin" link, or a gate redirecting someone to /dashboard). Either
  // way it 308s to the right hostname instead of 404ing.
  const redirectTarget = appHost
    ? redirectTargetForHost(appHost, pathname)
    : null;

  /** Serve this request, rewriting into the host's segment when it has one. */
  const serve = () => {
    if (redirectTarget) {
      const url = new URL(redirectTarget);
      url.search = request.nextUrl.search;
      return NextResponse.redirect(url, 308);
    }
    if (!rewriteTarget) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = rewriteTarget;
    return NextResponse.rewrite(url);
  };

  const isPublicRoute = PUBLIC_ROUTES.includes(pathname);
  const isPending2FARoute = PENDING_2FA_ROUTES.includes(pathname);
  const token = request.cookies.get("admin_session")?.value;
  const pendingToken = request.cookies.get("admin_2fa_pending")?.value;

  const session = token ? await decrypt(token) : null;
  const isAuthenticated = session && new Date(session.expiresAt) > new Date();

  // If there's a token but it's invalid/expired, clear it to prevent redirect loops
  if (token && !isAuthenticated) {
    const response = isPublicRoute
      ? NextResponse.next()
      : NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete("admin_session");
    return response;
  }

  const hasPendingSession = !!pendingToken;

  // Fully authenticated users: redirect away from login and 2FA routes.
  //
  // EXCEPTION (Phase D mandatory-2FA): `/setup-2fa` is NOT bounced for an
  // authenticated user. `verifySession` (src/lib/dal.ts) redirects an
  // authenticated-but-NOT-enrolled admin here to finish enrollment; bouncing
  // them back to /dashboard would create an infinite redirect loop. The
  // setup-2fa page itself (src/app/(auth)/setup-2fa/page.tsx) sends an
  // ALREADY-enrolled admin straight to their dashboard, so a normal admin who
  // lands here by any path is not stuck — only a genuinely non-enrolled user
  // stays to complete setup. `/verify-2fa` is still bounced (an enrolled,
  // already-authenticated user has nothing to verify). `/login` is still
  // bounced. This is the ONLY behavioral change to the authenticated branch.
  if (isAuthenticated) {
    // Legacy /chat bookmark → resolve the redirect at the HTTP layer, BEFORE
    // React renders. chat/page.tsx did this with an in-render redirect(); an
    // unconditional in-render redirect on the initial document load is replayed
    // by the App Router and corrupts its internal hook count (transient React
    // #310). Doing it here removes that trigger entirely (same rationale as the
    // static config redirects in next.config.ts).
    if (pathname === "/chat") {
      // Host-aware: on a segment host the role landing routes don't exist, so
      // fall back to that host's own landing instead of a guaranteed 404.
      const dest = appHost?.basePath
        ? "/"
        : DEFAULT_ROUTE_BY_ROLE[session.role] ?? "/dashboard";
      return NextResponse.redirect(new URL(dest, request.url));
    }

    const isSetup2FARoute = pathname === "/setup-2fa";
    if ((isPublicRoute || isPending2FARoute) && !isSetup2FARoute) {
      // Each host has its own landing page: a segment host's role routes
      // (/dashboard, /users, …) don't exist there, and `marketing` deliberately
      // lands on /analytics rather than the viewer's role default. Falling back
      // to the role map keeps single-domain behaviour identical.
      //
      // On a segment host we bounce to "/" rather than to the base path
      // itself: the rewrite resolves "/" to the segment anyway, and this keeps
      // the visible URL clean (packs.packydash.com/ not /pack-studio).
      const defaultRoute = appHost
        ? appHost.basePath
          ? "/"
          : appHost.landing
        : DEFAULT_ROUTE_BY_ROLE[session.role] ?? "/dashboard";
      return NextResponse.redirect(new URL(defaultRoute, request.url));
    }

    // ── Per-host front-door gate ─────────────────────────────────────────
    // A support user has no business landing on packs. or marketing. — bounce
    // them to the apex, where their own permissions apply as normal.
    //
    // This is ROUTING, not the security boundary, and it is deliberately
    // coarse: middleware only has the signed JWT, so it can't see the ADMIN-DB
    // access toggles or per-username allowlists, and `isAllowedOnHost` fails
    // OPEN for anything it can't determine. The real gates are unchanged —
    // each sub-app layout still runs `canAccessPackStudio` /
    // `canAccessAntifraud` against fresh DB state, and every page still runs
    // its own `requirePageAccess`. Nothing here grants access; it only
    // redirects someone away from a door that clearly isn't theirs.
    //
    // Note this cannot lock anyone out: the apex has no role restriction, so
    // the bounce always lands somewhere usable.
    if (appHost && !isAllowedOnHost(appHost, session)) {
      const apex = APP_HOSTS[0];
      const url = new URL(`https://${apex.host}${apex.landing}`);
      return NextResponse.redirect(url, 307);
    }

    return serve();
  }

  // Users with pending 2FA session — force them to complete the 2FA flow.
  // Allowing /login access here would let a user restart the credential
  // check while holding a pending-2FA cookie for another account.
  if (hasPendingSession) {
    if (isPending2FARoute) {
      return NextResponse.next();
    }
    return NextResponse.redirect(new URL("/verify-2fa", request.url));
  }

  // Unauthenticated users
  if (!isPublicRoute) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Public route (/login). `serve()` is a plain next() here — /login is on the
  // antifraud host's passthrough list, so it renders as itself.
  return serve();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$|.*\\.ico$).*)"],
};
