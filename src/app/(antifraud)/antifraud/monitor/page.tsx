
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";

import { MonitorConsole } from "./monitor-console";

export const metadata = { title: "Live Monitor" };

/**
 * Antifraud → Live behaviour monitor.
 *
 * The page itself has no server read: the console is a client island that
 * paints from one snapshot fetch and is then driven entirely by the SSE
 * stream, so there is nothing to wrap in a Suspense boundary here. The shell
 * (hero + section heading) renders immediately, which is what `loading.tsx`
 * mirrors.
 */
export default async function AntifraudMonitorPage() {
  await requireAntifraudPageAccess();

  return (
    <div className="space-y-5">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <MonitorConsole />
    </div>
  );
}
