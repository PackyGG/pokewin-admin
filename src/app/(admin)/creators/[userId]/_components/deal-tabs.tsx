"use client";

import { useOptimistic, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  CardAction,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type TabValue = "deals" | "sessions" | "pending";

type Props = {
  value: TabValue;
  counts: { deals: number; sessions: number; pending: number };
  action?: React.ReactNode;
  dealsPanel: React.ReactNode;
  sessionsPanel: React.ReactNode;
  pendingPanel: React.ReactNode;
};

/**
 * URL-driven Tabs wrapper. Switches are optimistic: clicking a tab flips
 * the visible panel immediately via `useOptimistic`, then fires off a
 * `router.replace` inside a transition so the RSC re-fetch (for the new
 * `?tab=` / pagination / filter params) happens without blocking the UI.
 *
 * Tab panels are passed in as slots (not children) so each can remain a
 * server component while this shell owns the client tab state.
 *
 * `keepMounted` on TabsContent means all three panels stay in the DOM —
 * they're already pre-rendered on the server, so there's no cost to
 * keeping them, and it avoids the remount glitch that happened on rapid
 * tab switching.
 */
export function DealTabs({
  value,
  counts,
  action,
  dealsPanel,
  sessionsPanel,
  pendingPanel,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [optimisticTab, setOptimisticTab] = useOptimistic(value);

  function onValueChange(next: TabValue) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);

    startTransition(() => {
      setOptimisticTab(next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  }

  return (
    <Tabs
      value={optimisticTab}
      onValueChange={(v) => onValueChange(v as TabValue)}
      className={cn("gap-0", isPending && "opacity-90")}
    >
      <CardHeader className="border-b">
        <TabsList variant="line" className="-mb-[3px] self-start">
          <TabsTrigger value="deals">
            Deals
            <span className="ml-1 text-muted-foreground">
              ({counts.deals})
            </span>
          </TabsTrigger>
          <TabsTrigger value="sessions">
            Sessions
            <span className="ml-1 text-muted-foreground">
              ({counts.sessions})
            </span>
          </TabsTrigger>
          <TabsTrigger value="pending">
            Pending
            <span className="ml-1 text-muted-foreground">
              ({counts.pending})
            </span>
          </TabsTrigger>
        </TabsList>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>

      <CardContent className="px-0">
        <TabsContent value="deals" keepMounted>
          {dealsPanel}
        </TabsContent>
        <TabsContent value="sessions" keepMounted>
          {sessionsPanel}
        </TabsContent>
        <TabsContent value="pending" keepMounted>
          {pendingPanel}
        </TabsContent>
      </CardContent>
    </Tabs>
  );
}
