import { Ban, AlertTriangle } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { getExcludedUsersForPage } from "@/lib/excluded-users/fetch";
import { requireExcludedUsersAccess } from "@/lib/excluded-users/gate";

import { ExcludedUsersClient } from "./excluded-users-client";

export const metadata = { title: "Excluded Users" };

/**
 * /system/excluded-users — motha-only blacklist management.
 *
 * Server-side: the `requireExcludedUsersAccess()` gate redirects
 * non-motha admins to /dashboard. Even though the sidebar entry
 * already hides the link via `usernameAllowlist`, the page gate is
 * the actual security boundary (an admin could still navigate by
 * URL otherwise).
 *
 * UI is intentionally minimal — a hero, a single table, and an
 * inline form. The actions are simple enough that splitting into a
 * detail page would just add clicks.
 */
export default async function ExcludedUsersPage() {
  await requireExcludedUsersAccess();
  const rows = await getExcludedUsersForPage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Ban}
          accent="rose"
          title="Excluded Users"
          subtitle="packy.gg user IDs whose activity is filtered out of dashboard, analytics, and PnL aggregates. Race / leaderboard queries deliberately keep counting these users."
        />
      </PageHero>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Scope:</span>{" "}
              the blacklist applies to dashboard KPIs, GGR, deposit /
              wager volume, PnL, top performers, retention, cohorts,
              creator PnL, and every other admin-facing analytics
              surface — but NOT race / rakeback / leaderboard queries
              (so blacklisting doesn&apos;t shift leaderboard positions).
            </p>
            <p>
              <span className="font-medium text-foreground">Access:</span>{" "}
              this page is restricted to the motha account. Server-side
              actions enforce the same gate independently of the sidebar
              visibility.
            </p>
          </div>
        </div>
      </div>

      <FadeIn>
        <ExcludedUsersClient initial={rows} />
      </FadeIn>
    </div>
  );
}
