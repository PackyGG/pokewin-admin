import { Suspense } from "react";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AdminHeader } from "@/components/admin-header";
import { HeaderRainSlot } from "@/components/header-rain-chip";
import { TopProgressBar } from "@/components/top-progress-bar";
import { TimezoneProvider } from "@/components/timezone-provider";
import { PageTransition } from "@/components/page-transition";
import { redirect, unstable_rethrow } from "next/navigation";
import { verifySession, getUserPermissions, sessionIsOwner } from "@/lib/dal";
import { getSession, type SessionPayload } from "@/lib/session";
import {
  getEffectiveRoles,
} from "@/lib/admin-roles";
import {
  canAccessCreatorHub,
  getCreatorHubAccessSettings,
  CREATOR_HUB_TOGGLE_ROLES,
  type CreatorHubAccessSettings,
} from "@/lib/creator-hub-access";
import { canAccessPackStudio } from "@/lib/pack-studio-access";
import {
  canAccessAntifraud,
  deniedAntifraudSettings,
  getAntifraudAccessSettings,
  getAntifraudUserAccess,
  unavailableAntifraudUserAccess,
  type AntifraudAccessSettings,
  type AntifraudUserAccess,
} from "@/lib/antifraud/access";
import { eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_users } from "@/lib/db-schema/admin/schema";
import { isPostgresError } from "@/lib/postgres-errors";
import { getAdminPreferences } from "@/lib/admin-preferences";
import { DEFAULT_PREFERENCES } from "@/lib/admin-preferences-types";
import { readDbEnvFromCookie, isDevDbConfigured } from "@/lib/db-env";
import { readTzCookie } from "@/lib/timezone/server";
import { DevDbBanner } from "@/components/dev-db-banner";
import { ScrollToTopOnNav } from "./scroll-to-top-on-nav";

/**
 * Read the optional profile fields. This runs on every admin page load,
 * so failures here crash the entire admin shell (including /settings,
 * /dashboard, everything). Any error — missing column/table, DB
 * unreachable, timeout, unexpected shape — falls back to null values so
 * the header just shows the username + initials instead of tearing
 * down the whole layout. The error is still logged so ops can see it.
 */
async function loadHeaderProfile(userId: string): Promise<{
  displayUsername: string | null;
  hasAvatar: boolean;
  email: string;
  /**
   * Whether the optional admin-DB profile columns (display_username /
   * profile_image_mime) exist. The profile dialog uses this to gate its
   * editing controls the same way the old /profile page did. Detected by
   * whether the column-bearing select threw P2022 / "column does not
   * exist" — any other failure keeps the safe `false` default.
   */
  profileFieldsAvailable: boolean;
}> {
  try {
    const [row] = await adminDrizzle.select({
      display_username: admin_users.display_username,
      profile_image_mime: admin_users.profile_image_mime,
      email: admin_users.email,
    }).from(admin_users).where(eq(admin_users.id, userId)).limit(1);
    return {
      displayUsername: row?.display_username ?? null,
      hasAvatar: Boolean(row?.profile_image_mime),
      email: row?.email ?? "",
      profileFieldsAvailable: true,
    };
  } catch (err) {
    // Pre-migration fallback: the profile columns don't exist yet. Re-read
    // just the always-present `email` so the dialog can still show identity,
    // and flag the profile fields as unavailable (controls disabled). Any
    // non-missing-column error keeps the fully-degraded default.
    const missingColumn =
      isPostgresError(err, "42703") ||
      (err instanceof Error && /column .* does not exist/i.test(err.message));
    if (missingColumn) {
      try {
        const [row] = await adminDrizzle.select({ email: admin_users.email })
          .from(admin_users).where(eq(admin_users.id, userId)).limit(1);
        return {
          displayUsername: null,
          hasAvatar: false,
          email: row?.email ?? "",
          profileFieldsAvailable: false,
        };
      } catch (inner) {
        console.error("[admin-layout] loadHeaderProfile email fallback failed:", inner);
      }
    }
    console.error("[admin-layout] loadHeaderProfile failed:", err);
    return {
      displayUsername: null,
      hasAvatar: false,
      email: "",
      profileFieldsAvailable: false,
    };
  }
}

/**
 * Resilient read of `getUserPermissions` for the layout. A transient
 * adminDb failure (connection blip, statement timeout) here would otherwise
 * crash the entire admin shell — which is exactly the failure mode
 * /dashboard, /cards, /packs hit in prod after the page-body queries were
 * already hardened with safeQuery. Falling back to an empty allow-list is
 * conservative: non-admins effectively see a stripped sidebar and the
 * page's own `requirePageAccess` gate decides whether to redirect; admins
 * (`session.role === "admin"`) bypass the list entirely so the empty array
 * has no effect on them. `redirect()` and `notFound()` signals from inside
 * the call are RE-THROWN so Next can complete the navigation.
 */
async function loadUserPermissions(userId: string): Promise<string[]> {
  try {
    return await getUserPermissions(userId);
  } catch (err) {
    unstable_rethrow(err);
    console.error("[admin-layout] loadUserPermissions failed:", err);
    return [];
  }
}

/**
 * Resilient read of `getAdminPreferences` for the layout. The preferences
 * column already self-heals for the unapplied-migration case (P2022), but
 * any OTHER throw — connection drop, timeout, unexpected shape — would
 * propagate past the layout and white-screen the shell. Falling back to
 * DEFAULT_PREFERENCES keeps the timezone provider's safe defaults so the
 * page still renders; the admin just sees the system theme + browser-
 * detected timezone until the next request recovers.
 */
async function loadPreferences(userId: string) {
  try {
    return await getAdminPreferences(userId);
  } catch (err) {
    unstable_rethrow(err);
    console.error("[admin-layout] loadPreferences failed:", err);
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Resilient read of the per-role Creator-Hub access toggles, used to decide
 * whether the "Switch to Creator Hub" portal button is shown in the
 * sidebar. The decision MUST be computed server-side (it depends on ADMIN-DB
 * settings the client can't read) and is gated identically to the
 * /creator-hub route guard. Any DB fault degrades to every toggle OFF
 * (fail-closed) so a blip can't reveal the portal to a non-owner — only the
 * hard-coded `motha` bypass in `canAccessCreatorHub` survives.
 */
async function loadCreatorHubAccessSettings(): Promise<CreatorHubAccessSettings> {
  try {
    return await getCreatorHubAccessSettings();
  } catch (err) {
    unstable_rethrow(err);
    console.error(
      "[admin-layout] loadCreatorHubAccessSettings failed, hiding portal for non-owner:",
      err,
    );
    return Object.fromEntries(
      CREATOR_HUB_TOGGLE_ROLES.map((role) => [role, false]),
    ) as CreatorHubAccessSettings;
  }
}

/**
 * Resilient read of the per-role Antifraud access toggles, used to decide
 * whether the "Switch to Antifraud" portal button (the third sub-app card) is
 * shown in the sidebar. Same contract as the two above: computed SERVER-SIDE,
 * gated identically to the /antifraud route guard, and any DB fault degrades to
 * every toggle OFF (fail-closed) — only the owner/admin bypass inside
 * `canAccessAntifraud` survives a blip.
 */
async function loadAntifraudAccessSettings(): Promise<AntifraudAccessSettings> {
  try {
    return await getAntifraudAccessSettings();
  } catch (err) {
    unstable_rethrow(err);
    console.error(
      "[admin-layout] loadAntifraudAccessSettings failed, hiding toggle-based portal:",
      err,
    );
    return deniedAntifraudSettings();
  }
}

/** Per-username Antifraud override read — role default on failure. */
async function loadAntifraudUserAccess(): Promise<AntifraudUserAccess> {
  try {
    return await getAntifraudUserAccess();
  } catch (err) {
    unstable_rethrow(err);
    console.error(
      "[admin-layout] loadAntifraudUserAccess failed, hiding portal:",
      err,
    );
    return unavailableAntifraudUserAccess();
  }
}

/**
 * Resilient wrapper around `verifySession()`. The session check itself is
 * cookie-only (cheap, can't throw for connectivity reasons), but the
 * DB-side `is_active` / role re-read inside it can throw if adminDb has a
 * transient fault — which would otherwise crash the entire admin shell at
 * its very first await (the layout's gate). On a non-control-flow DB
 * failure we fall back to the JWT payload alone: it was signed at login,
 * so the user IS authenticated; the DB refresh only exists to surface
 * stale role state. A few seconds of stale role data is the right trade
 * vs white-screening every page. Cookie-missing / expired redirects are
 * preserved verbatim.
 */
async function safeVerifySession(): Promise<SessionPayload> {
  try {
    return await verifySession();
  } catch (err) {
    unstable_rethrow(err);
    console.error(
      "[admin-layout] safeVerifySession DB lookup failed, falling back to JWT:",
      err,
    );
    const session = await getSession();
    if (!session) redirect("/login");
    if (new Date(session.expiresAt) < new Date()) redirect("/login");
    // The JWT carries `role` always; `roles` was added with multi-role and
    // older cookies may omit it. Mirror verifySession's normalization so
    // every downstream consumer sees a consistent shape.
    const roles = getEffectiveRoles(session.role, session.roles);
    return { ...session, roles };
  }
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await safeVerifySession();
  // Permissions, header profile, preferences, and the current DB env
  // are independent lookups keyed on the same userId/cookie jar.
  // Serializing them cost ~4 round-trips on every admin page load —
  // Promise.all collapses them into one.
  //
  // Every entry is wrapped by a layout-local helper that catches non-
  // control-flow errors and returns a safe fallback so a transient
  // adminDb fault can't take the whole admin shell down (the failure mode
  // that white-screened /dashboard, /cards, /packs in prod after their
  // page-body queries were already hardened with safeQuery). Each wrapper
  // re-throws `redirect()` / `notFound()` so navigation still works.
  const [
    allowedPages,
    profile,
    preferences,
    dbEnv,
    tzCookie,
    hubAccessSettings,
    antifraudAccessSettings,
    antifraudUserAccess,
  ] = await Promise.all([
    loadUserPermissions(session.userId),
    loadHeaderProfile(session.userId),
    loadPreferences(session.userId),
    readDbEnvFromCookie(),
    // Browser-detected zone from the `admin_tz` cookie. Passed to the
    // TimezoneProvider so its first client paint matches this SSR render
    // (no hydration flash) when the admin has no explicit pref. readTzCookie
    // never throws (background-ctx safe) and returns null when absent.
    readTzCookie(),
    loadCreatorHubAccessSettings(),
    loadAntifraudAccessSettings(),
    loadAntifraudUserAccess(),
  ]);
  // Only surface the switcher to admins on servers where a dev DB is
  // actually configured; otherwise the toggle would be a dead option.
  const canSwitchDbEnv = session.role === "admin" && isDevDbConfigured();

  // Whether to show the "Switch to Creator Hub" portal in the sidebar.
  // Computed server-side (it depends on ADMIN-DB toggles) and matched 1:1
  // to the /creator-hub route guard so the button never appears for a user
  // who would be redirected out of the Hub. Default (both toggles off):
  // only `motha`.
  const canEnterCreatorHub = canAccessCreatorHub(session, hubAccessSettings);

  // Matched 1:1 to the role-owned /pack-studio route guard.
  const canEnterPackStudio = canAccessPackStudio(session);

  // Whether to show the "Switch to Antifraud" portal (third sub-app card).
  // Same server-side computation + 1:1 match to the /antifraud route guard.
  // Default: owners + admins; other roles need their toggle flipped or an
  // explicit username allowlist entry.
  const canEnterAntifraud = canAccessAntifraud(
    session,
    antifraudAccessSettings,
    antifraudUserAccess,
  );

  // OWNER / ultra-admin flag for the sidebar. Computed server-side from the
  // DB-fresh session (verifySession populated `session.isOwner`); the permanent
  // `motha` username is owner regardless. Lets the sidebar show the owner-only
  // nav items (Salaries, Excluded Users, Insights group) to any owner and
  // bypass the page-access gate for them. Fail-closed: the DB-failure session
  // fallback only ever yields `true` for the `motha` username.
  const isOwner = sessionIsOwner(session);

  return (
    <TimezoneProvider
      initialTimezone={preferences.timezone}
      cookieTimezone={tzCookie}
      initialDateFormat={preferences.dateFormat}
    >
      <SidebarProvider>
        {/* Suspense wrapper is required — TopProgressBar uses useSearchParams
            which suspends during SSR. Nothing to render while it suspends. */}
        <Suspense fallback={null}>
          <TopProgressBar />
        </Suspense>
        <AppSidebar
          viewerId={session.userId}
          role={session.role}
          roles={session.roles ?? [session.role]}
          allowedPages={allowedPages}
          username={session.username}
          dbEnv={dbEnv}
          canEnterCreatorHub={canEnterCreatorHub}
          canEnterPackStudio={canEnterPackStudio}
          canEnterAntifraud={canEnterAntifraud}
          isOwner={isOwner}
        />
        {/* SidebarInset is the shadcn shell partner to <Sidebar> — it's the
            <main> landmark that flexes to fill the space beside the sidebar
            and (in inset variants) gets the rounded/elevated treatment. We
            keep the existing default ("sidebar") variant, so visually this is
            the same full-bleed column the old plain <div> produced, just
            wired through the primitive so the sidebar/inset geometry (gap,
            collapse width) is owned in one place. `min-w-0` is preserved so
            flex children (wide tables/charts) can shrink instead of forcing
            the whole shell to scroll horizontally. */}
        <SidebarInset className="min-w-0">
          {dbEnv === "dev" && <DevDbBanner />}
          <AdminHeader
            adminId={session.userId}
            username={session.username}
            displayUsername={profile.displayUsername}
            email={profile.email}
            hasAvatar={profile.hasAvatar}
            role={session.role}
            roles={session.roles ?? [session.role]}
            profileFieldsAvailable={profile.profileFieldsAvailable}
            preferences={preferences}
            dbEnv={dbEnv}
            canSwitchDbEnv={canSwitchDbEnv}
            rainSlot={<HeaderRainSlot />}
          />
          {/* Scrollable content region. This used to be a <main>, but the
              SidebarInset wrapper above is now the page's single <main>
              landmark, so this is a plain <div> (nesting <main> in <main> is
              invalid). `min-w-0` is required so flex children can shrink below
              their intrinsic content width — without it, a wide table or chart
              forces the entire shell to scroll horizontally instead of just
              the offending element. `pb-[env(safe-area-inset-bottom)]` gives
              iOS notched devices breathing room above the home bar. */}
          <div
            data-admin-scroll
            className="flex-1 overflow-auto min-w-0 p-3 sm:p-4 md:p-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          >
            {/* Resets this container to scrollTop:0 on real route (pathname)
                changes. Keyed on pathname only, so ?period=/?tab= param-only
                updates (which pass scroll:false) are left in place. */}
            <ScrollToTopOnNav />
            {/* Subtle route-enter animation: keys on pathname only, so a new
                page eases in (fade + 1px slide) while in-page ?tab=/?period=
                param updates do NOT re-animate. Wraps the outer content, so
                Suspense fallbacks inside still stream; no layout shift, no
                extra fetches. Reduced-motion → instant final state. */}
            <PageTransition>{children}</PageTransition>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TimezoneProvider>
  );
}
