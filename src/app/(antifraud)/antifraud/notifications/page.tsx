import { BellRing, ShieldCheck } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { listAntifraudDashboardNotificationRules } from "@/lib/antifraud/dashboard-notification-rules";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { DashboardNotificationWorkspace } from "./workspace";

export const metadata = { title: "Dashboard Notifications · Antifraud" };

export default async function AntifraudNotificationsPage() {
  await requireAntifraudManagerPage();
  const config = await listAntifraudDashboardNotificationRules();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <section className="space-y-3">
        <SectionHeading icon={BellRing} title="On-site alert rules" />
        <p className="max-w-3xl text-sm text-muted-foreground">
          Route Fraud events to dashboard staff groups. Rules are opt-in:
          this workspace ships with no automatic rule, and creating a disabled
          draft sends nothing.
        </p>
        <div className="flex gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          This is separate from manual System announcements and external
          Discord routing.
        </div>
      </section>

      <DashboardNotificationWorkspace
        initialRules={config.rules}
        events={config.events}
      />
    </div>
  );
}
