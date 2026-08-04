import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";

export const metadata = { title: "Sign-up Checks Guide · Antifraud" };

export default async function AntifraudSignupGuidePage() {
  await requireAntifraudPageAccess();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-600 dark:text-cyan-400">
          Guide
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Sign-up checks
        </h1>
      </div>
    </div>
  );
}
