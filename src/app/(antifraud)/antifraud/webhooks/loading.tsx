import { Webhook } from "lucide-react";

import { KpiStripSkeleton } from "@/components/loading-skeletons";
import { SectionHeading } from "@/components/modern-panels";

export default function WebhooksLoading() {
  return (
    <div className="space-y-6">
      <div>
        <SectionHeading icon={Webhook} title="Webhooks" />
        <div className="mt-2 h-5 w-full max-w-2xl animate-pulse rounded bg-muted/50" />
      </div>
      <KpiStripSkeleton count={3} />
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="h-52 animate-pulse rounded-xl border bg-muted/35"
          />
        ))}
      </div>
    </div>
  );
}
