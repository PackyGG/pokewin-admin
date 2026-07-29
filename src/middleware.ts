import { NextRequest, NextResponse } from "next/server";
import { decrypt } from "@/lib/session";
import {
  APP_HOSTS,
  isAllowedOnHost,
  redirectTargetForHost,
  resolveAppHost,
  rewritePathForHost,
} from "@/lib/app-hosts";
import {
  getDefaultRoute,
  getEffectiveRoles,
  isDedicatedPackBuilder,
  isPackBuilderContentPath,
} from "@/lib/admin-roles";
import { isRootOwnerUsername } from "@/lib/owners-shared";

const PUBLIC_ROUTES = ["/login"];
const PENDING_2FA_ROUTES = ["/verify-2fa", "/setup-2fa"];

// Role → landing page. Used both for the post-login bounce and the legacy
// /chat bookmark redirect below. The shared role→landing table is
// `getDefaultRoute` (src/lib/admin-roles.ts, edge-safe) so new roles like
// creator_manager/creator/pack_creator can't drift out of sync again;
// middleware only holds the signed JWT (no allowed_pages), so the two roles
// whose landing depends on page access keep explicit overrides to the surface
// they can always reach instead of getDefaultRoute's /dashboard fallback.
// Chat is a slide-out panel now, so support/marketing land on a real page.
const LANDING_OVERRIDES: Record<string, string> = {
  support: "/users",
  marketing: "/analytics",
};

function landingRouteForRole(role: string): string {
  return LANDING_OVERRIDES[role] ?? getDefaultRoute(role);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Multi-host routing ───────────────────────────────────────────────────
  // One deployment serves several hostnames, each fronting a different part of
  // the app (see src/lib/app-hosts.ts):
  //
  //   packydash.com           → main dashboard   (landing host, no rewrite)
  //   packs.packydash.com     → Pack Studio      (rewrites into /pack-studio)
  //   fraud.packydash.com     → Antifraud        (rewrites into /antifraud)
  //   marketing.packydash.com → Creator Hub      (rewrites into /creator-hub)
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
    // The normal Admin app consolidated its legacy /withdrawals list into the
    // Transactions page. Keep that redirect host-aware: the Fraud subdomain
    // owns /withdrawals as a real behavioral review workspace, so a global
    // next.config redirect would intercept it before this host rewrite runs.
    if (
      pathname === "/withdrawals" &&
      appHost?.basePath !== "/antifraud"
    ) {
      const url = new URL("/transactions/deposits", request.url);
      url.search = request.nextUrl.search;
      url.searchParams.set("tab", "withdrawals");
      return NextResponse.redirect(url, 308);
    }
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

  // Like the session cookie above, the pending-2FA cookie only counts when it
  // actually verifies. A tampered / secret-rotated / undecryptable pending
  // token would otherwise bounce every request to /verify-2fa, whose page sees
  // getPendingSession() === null and redirects back to /login — an infinite
  // 307 loop until the 5-minute cookie expires. Delete the bad cookie and fall
  // through as unauthenticated instead. (Skipped when a valid full session
  // exists — the authenticated branch below never reads the pending state.)
  const pendingSession =
    !isAuthenticated && pendingToken ? await decrypt(pendingToken) : null;
  if (!isAuthenticated && pendingToken && !pendingSession) {
    const response = isPublicRoute
      ? NextResponse.next()
      : NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete("admin_2fa_pending");
    return response;
  }

  const hasPendingSession = pendingSession !== null;

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
    const sessionRoles = getEffectiveRoles(session.role, session.roles);
    const owner =
      session.isOwner === true || isRootOwnerUsername(session.username);
    const dedicatedPackBuilder =
      !owner && isDedicatedPackBuilder(sessionRoles);

    // Fiat Fraud and Whop Refunds moved from the Admin Transactions tabs to
    // the Fraud workspace. Resolve retired cross-host deep links at the HTTP layer:
    // an App Router redirect emitted from the page's RSC response can make
    // React attempt a cross-origin RSC navigation first and crash with #310.
    // Preserve every existing filter/pagination value, dropping only the
    // retired tab selector. Fires on landing hosts AND on unmatched hosts
    // (pokewin-admin.vercel.app, previews) — both serve the main app at
    // canonical paths, so both would otherwise fall through to the in-render
    // redirect this block exists to prevent. Segment hosts are excluded: they
    // never serve /transactions/deposits in the first place.
    const retiredTransactionsTab =
      request.nextUrl.searchParams.get("tab");
    const fraudTransactionsRoute =
      retiredTransactionsTab === "fiat-fraud"
        ? "fiat-fraud"
        : retiredTransactionsTab === "refunds"
          ? "refunds"
          : null;
    if (
      (!appHost || appHost.basePath === null) &&
      pathname === "/transactions/deposits" &&
      fraudTransactionsRoute
    ) {
      const fraudHost = APP_HOSTS.find(
        (entry) => entry.basePath === "/antifraud",
      );
      if (fraudHost) {
        const url = new URL(
          `https://${fraudHost.host}/${fraudTransactionsRoute}`,
        );
        request.nextUrl.searchParams.forEach((value, key) => {
          if (key !== "tab") url.searchParams.append(key, value);
        });
        return NextResponse.redirect(url, 308);
      }
    }

    // Dedicated Pack Builders may use Pack Studio plus only the Packs, Cards,
    // and Sets route families in the normal dashboard. Enforce this before a
    // page or server action renders; the DB-fresh page/capability gates remain
    // the second security boundary.
    if (
      dedicatedPackBuilder &&
      appHost?.basePath !== "/pack-studio" &&
      pathname !== "/pack-studio" &&
      !pathname.startsWith("/pack-studio/") &&
      !isPackBuilderContentPath(pathname) &&
      pathname !== "/setup-2fa"
    ) {
      return NextResponse.redirect(new URL("/pack-studio", request.url), 307);
    }

    // Legacy Antifraud inbox URL -> canonical shared System inbox. This must
    // happen before the App Router renders the redirect page: a cross-origin
    // redirect emitted from an RSC response makes React try an impossible
    // cross-host RSC fetch first, producing React #310 before the hard
    // navigation succeeds.
    if (appHost?.basePath === "/antifraud" && pathname === "/notifications") {
      const apex = APP_HOSTS[0];
      return NextResponse.redirect(
        new URL(`https://${apex.host}/system/staff-notifications`),
        308,
      );
    }
    if (appHost?.basePath === "/antifraud" && pathname === "/settings/api") {
      return NextResponse.redirect(new URL("/api", request.url), 308);
    }
    if (appHost?.basePath === null && pathname === "/webhooks") {
      const fraudHost = APP_HOSTS.find(
        (entry) => entry.basePath === "/antifraud",
      );
      if (fraudHost) {
        const url = new URL(`https://${fraudHost.host}/webhooks`);
        url.search = request.nextUrl.search;
        return NextResponse.redirect(url, 308);
      }
    }

    // Creator Rewards moved out of the apex dashboard and now belongs only to
    // the Marketing workspace. Keep old bookmarks useful without retaining a
    // duplicate App Router page in the normal admin app.
    if (pathname === "/creator-rewards") {
      const creatorHub = APP_HOSTS.find(
        (entry) => entry.basePath === "/creator-hub",
      );
      if (creatorHub) {
        const url = new URL(`https://${creatorHub.host}/rewards`);
        url.search = request.nextUrl.search;
        return NextResponse.redirect(url, 308);
      }
    }

    // Creator Fraud now belongs to the Marketing workspace. Resolve old Fraud
    // host bookmarks and old canonical prefixed URLs before App Router renders,
    // preserving the detail path and every search/filter value.
    const legacyCreatorFraudPath =
      appHost?.basePath === "/antifraud" &&
      (pathname === "/creator-fraud" ||
        pathname.startsWith("/creator-fraud/"))
        ? pathname
        : pathname === "/antifraud/creator-fraud" ||
            pathname.startsWith("/antifraud/creator-fraud/")
          ? pathname.slice("/antifraud".length)
          : null;
    if (legacyCreatorFraudPath) {
      const creatorHub = APP_HOSTS.find(
        (entry) => entry.basePath === "/creator-hub",
      );
      if (creatorHub) {
        const url = new URL(
          `https://${creatorHub.host}${legacyCreatorFraudPath}`,
        );
        url.search = request.nextUrl.search;
        return NextResponse.redirect(url, 308);
      }
    }

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
        : landingRouteForRole(session.role);
      return NextResponse.redirect(new URL(dest, request.url));
    }

    const isSetup2FARoute = pathname === "/setup-2fa";
    if ((isPublicRoute || isPending2FARoute) && !isSetup2FARoute) {
      // Each host has its own landing page: a segment host's role routes
      // (/dashboard, /users, …) don't exist there. Falling back to the role
      // map keeps single-domain behaviour identical.
      //
      // On a segment host we bounce to "/" rather than to the base path
      // itself: the rewrite resolves "/" to the segment anyway, and this keeps
      // the visible URL clean (packs.packydash.com/ not /pack-studio).
      const defaultRoute = appHost
        ? appHost.basePath
          ? "/"
          : appHost.landing
        : landingRouteForRole(session.role);
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
  // The negative lookahead excludes only `api/` (with trailing slash), so the
  // bare `/api` path (the antifraud API settings page) is already matched and
  // middleware-protected by this single pattern — no separate entry needed.
  matcher: [
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$|.*\\.ico$).*)",
  ],
};
