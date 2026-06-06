import { KeyRound, ShieldCheck } from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { getIntegrationKeyRows } from "@/lib/integration-settings";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

import { IntegrationKeysForm } from "./integration-keys-form";

export const metadata = { title: "Settings · Creator Hub" };

/**
 * Creator Hub — Settings (integration API keys).
 *
 * Lets a manager configure the third-party RapidAPI keys the Hub uses to pull
 * per-creator Kick + Twitter/X data (plan: iridescent-mixing-lecun.md →
 * "API-key handling"). The keys live in the ADMIN DB `admin_settings` table,
 * NOT env vars, per the owner's spec.
 *
 * SECURITY:
 *  - ACCESS is gated to the SAME rule as the rest of the Creator Hub
 *    (`canAccessCreatorHub`: founder `motha`, or a role whose ADMIN-DB toggle
 *    is on). We enforce it explicitly here in addition to the layout guard so
 *    the page can't be reached out of context, and resolve the same redirect
 *    the layout/DAL uses for a non-eligible viewer.
 *  - The raw keys are SECRETS: this server component reads only the masked
 *    rows ({@link getIntegrationKeyRows}: set/unset + last-4 preview +
 *    last-updated + resolved editor name) and passes that to the client. The
 *    actual secret never enters the client payload — it's written via a
 *    server action and read only server-side for the API calls.
 */
export default async function CreatorHubSettingsPage() {
  await requireCreatorHubPageAccess();

  // Masked, name-resolved rows only — no raw secret crosses the RSC boundary.
  const rows = await getIntegrationKeyRows();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={KeyRound}
          accent="cyan"
          title="Settings"
          subtitle="Integration API keys · power the Kick & Twitter data the Hub pulls per creator"
        />
      </PageHero>

      <FadeIn>
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.06] p-3 text-xs text-muted-foreground sm:text-sm">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-cyan-600 dark:text-cyan-400" />
            <p>
              These RapidAPI keys are stored server-side in the admin database
              and used only for server-to-server calls. The stored key is never
              shown again or sent to your browser — you&apos;ll only see a
              masked preview and when it was last changed. Every change is
              recorded in the audit log.
            </p>
          </div>

          <IntegrationKeysForm rows={rows} />
        </div>
      </FadeIn>
    </div>
  );
}
