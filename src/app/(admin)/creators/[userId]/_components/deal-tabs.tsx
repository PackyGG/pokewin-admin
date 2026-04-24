"use client";

import { useEffect, useState } from "react";

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
 * All three panels are pre-rendered server-side with their own
 * pagination/filter defaults. Switching tabs only hides/shows already
 * mounted content — we sync the URL via `window.history.replaceState`
 * so deep-linking still works without firing a full RSC re-fetch on
 * every click. Pagination / filter changes inside a panel still go
 * through the normal router and re-fetch the data they need.
 */
export function DealTabs({
  value,
  counts,
  action,
  dealsPanel,
  sessionsPanel,
  pendingPanel,
}: Props) {
  const [tab, setTab] = useState<TabValue>(value);

  useEffect(() => {
    setTab(value);
  }, [value]);

  function onValueChange(next: string) {
    const tabValue = next as TabValue;
    setTab(tabValue);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tabValue);
      window.history.replaceState(null, "", url.toString());
    }
  }

  return (
    <Tabs value={tab} onValueChange={onValueChange} className="gap-0">
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
