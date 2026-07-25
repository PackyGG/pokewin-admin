import { NextRequest, NextResponse } from "next/server";
import { decrypt } from "@/lib/session";
import {
  antifraudRewritePath,
  isAntifraudHost,
  ANTIFRAUD_BASE_PATH,
} from "@/lib/antifraud/host";

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

  // ── Antifraud host routing ───────────────────────────────────────────────
  // The Antifraud workspace is ALSO served from its own hostname
  // (fraud.packydash.com). Requests arriving there are REWRITTEN into the
  // /antifraud route segment, so one build + one session serves both entry
  // points and `fraud.packydash.com/reviews` renders the same tree as
  // `packydash.com/antifraud/reviews`.
  //
  // This is INERT until the DNS record points at this deployment: a request
  // whose Host doesn't match falls through with `onAntifraudHost === false` and
  // every line below behaves exactly as it did before. Auth still runs first —
  // the rewrite is applied only on the paths that would otherwise have been
  // served (`NextResponse.next()`), never in place of a login redirect.
  const onAntifraudHost = isAntifraudHost(request.headers.get("host"));
  const antifraudTarget = onAntifraudHost
    ? antifraudRewritePath(pathname)
    : null;

  /** Serve this request, rewriting into /antifraud when on the fraud host. */
  const serve = () => {
    if (!antifraudTarget) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = antifraudTarget;
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
      const dest = DEFAULT_ROUTE_BY_ROLE[session.role] ?? "/dashboard";
      return NextResponse.redirect(new URL(dest, request.url));
    }

    const isSetup2FARoute = pathname === "/setup-2fa";
    if ((isPublicRoute || isPending2FARoute) && !isSetup2FARoute) {
      // On the antifraud host the role landing routes (/dashboard, /users, …)
      // don't exist — everything there lives under /antifraud. Send them to the
      // host root instead, which the rewrite above resolves to the workspace.
      const defaultRoute = onAntifraudHost
        ? ANTIFRAUD_BASE_PATH
        : DEFAULT_ROUTE_BY_ROLE[session.role] ?? "/dashboard";
      return NextResponse.redirect(new URL(defaultRoute, request.url));
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
