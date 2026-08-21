import { CalendarClock } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { getSubscriptionPageData } from "@/lib/queries/finance-costs";
import { requireMotha } from "@/lib/salary/motha-gate";

import { SubscriptionsClient } from "./subscriptions-client";

export const metadata = { title: "Subscriptions · Finances" };

export default async function SubscriptionsPage() {
  await requireMotha();
  const data = await getSubscriptionPageData();

  return (
    <div className="space-y-6">
      <SectionHeading icon={CalendarClock} title="Subscriptions" />
      <SubscriptionsClient data={data} />
    </div>
  );
}
