import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
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

      <DashboardNotificationWorkspace
        initialRules={config.rules}
        events={config.events}
      />
    </div>
  );
}
