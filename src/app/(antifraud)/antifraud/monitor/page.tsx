import { RadioTower } from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { SectionHeading } from "@/components/modern-panels";

import { MonitorConsole } from "./monitor-console";

export const metadata = { title: "Live Monitor" };

export default async function AntifraudMonitorPage() {
  await requireAntifraudPageAccess();

  return (
    <div className="space-y-5">
      <SectionHeading
        icon={RadioTower}
        title="Live behavior monitor"
      />
      <MonitorConsole />
    </div>
  );
}
