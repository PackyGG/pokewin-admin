import Link from "next/link";
import {
  BarChart3,
  CreditCard,
  Settings2,
  ShieldCheck,
  Webhook,
} from "lucide-react";

import { LinkPendingShell } from "@/components/ux";
import { cn } from "@/lib/utils";
import { FIAT_TABS, type FiatTab } from "../tabs";

const TAB_META = {
  overview: { label: "Overview", icon: BarChart3 },
  configuration: { label: "Configuration", icon: Settings2 },
  payments: { label: "Payments", icon: CreditCard },
  access: { label: "Access & holds", icon: ShieldCheck },
  webhooks: { label: "Webhooks", icon: Webhook },
} satisfies Record<FiatTab, { label: string; icon: typeof BarChart3 }>;

export function FiatTabNav({ current }: { current: FiatTab }) {
  return (
    <div
      role="tablist"
      aria-label="Fiat workspace sections"
      className="flex gap-1 overflow-x-auto rounded-lg border bg-muted/50 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {FIAT_TABS.map((tab) => {
        const { label, icon: Icon } = TAB_META[tab];
        const active = current === tab;
        return (
          <Link
            key={tab}
            role="tab"
            aria-selected={active}
            aria-current={active ? "page" : undefined}
            href={tab === "overview" ? "/fiat" : `/fiat?tab=${tab}`}
            replace
            scroll={false}
            prefetch={false}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <LinkPendingShell spinnerSize={13}>
              <Icon className="size-3.5" />
              {label}
            </LinkPendingShell>
          </Link>
        );
      })}
    </div>
  );
}
