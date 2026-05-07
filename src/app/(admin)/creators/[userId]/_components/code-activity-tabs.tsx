"use client";

import { useState } from "react";
import Link from "next/link";
import { Activity, Users } from "lucide-react";

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

type TabValue = "users" | "wagers";

type Props = {
  code: string;
  counts: { users: number; wagers: number };
  usersPanel: React.ReactNode;
  wagersPanel: React.ReactNode;
};

/**
 * Tabbed code-activity panel for the creator detail page. Wraps the
 * server-rendered "Users on this code" and "Last wagers" tables in
 * shadcn Tabs so the admin can flip between them in-place. Both
 * panels are pre-rendered server-side and kept mounted; the tab
 * switch only hides/shows them — no RSC re-fetch on click.
 *
 * Header has the section icon + count badges next to each tab label
 * (matches DealTabs above on the same page) plus a "Full breakdown
 * →" link out to /creators/codes/[code] when there's at least one
 * user on the code.
 */
export function CodeActivityTabs({
  code,
  counts,
  usersPanel,
  wagersPanel,
}: Props) {
  const [tab, setTab] = useState<TabValue>("users");

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as TabValue)}
      className="gap-0"
    >
      <CardHeader className="border-b">
        <TabsList variant="line" className="-mb-[3px] self-start">
          <TabsTrigger value="users">
            <Users className="size-3.5" />
            Users on code
            <span className="ml-1 text-muted-foreground">
              ({counts.users})
            </span>
          </TabsTrigger>
          <TabsTrigger value="wagers">
            <Activity className="size-3.5" />
            Last wagers
            <span className="ml-1 text-muted-foreground">
              ({counts.wagers})
            </span>
          </TabsTrigger>
        </TabsList>
        {counts.users > 0 && (
          <CardAction>
            <Link
              href={`/creators/codes/${code}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Full breakdown →
            </Link>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="px-0">
        <TabsContent value="users" keepMounted>
          {usersPanel}
        </TabsContent>
        <TabsContent value="wagers" keepMounted>
          {wagersPanel}
        </TabsContent>
      </CardContent>
    </Tabs>
  );
}
