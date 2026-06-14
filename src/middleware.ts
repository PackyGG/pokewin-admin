import { NextRequest, NextResponse } from "next/server";
import { decrypt } from "@/lib/session";

const PUBLIC_ROUTES = ["/login"];
const PENDING_2FA_ROUTES = ["/verify-2fa", "/setup-2fa"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
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
    const isSetup2FARoute = pathname === "/setup-2fa";
    if ((isPublicRoute || isPending2FARoute) && !isSetup2FARoute) {
      // Chat is now a slide-out panel available from every page, so
      // support/marketing land on a real page instead of the old /chat route.
      const defaultRoutes: Record<string, string> = {
        admin: "/dashboard",
        support: "/users",
        marketing: "/analytics",
      };
      const defaultRoute = defaultRoutes[session.role] ?? "/dashboard";
      return NextResponse.redirect(new URL(defaultRoute, request.url));
    }
    return NextResponse.next();
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

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$|.*\\.ico$).*)"],
};
