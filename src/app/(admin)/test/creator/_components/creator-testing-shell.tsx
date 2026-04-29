"use client";

import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { UsersTab } from "./users-tab";
import { CodesTab } from "./codes-tab";
import { LeaderboardsTab } from "./leaderboards-tab";
import { RoutingTab } from "./routing-tab";
import { SimulatorTab } from "./simulator-tab";

type TabValue = "users" | "codes" | "leaderboards" | "routing" | "simulator";

export function CreatorTestingShell() {
  const [tab, setTab] = useState<TabValue>("users");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Tools</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
          <TabsList className="grid grid-cols-5 w-full max-w-3xl">
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="codes">Codes</TabsTrigger>
            <TabsTrigger value="leaderboards">Leaderboards</TabsTrigger>
            <TabsTrigger value="routing">Routing</TabsTrigger>
            <TabsTrigger value="simulator">Simulator</TabsTrigger>
          </TabsList>

          <TabsContent value="users" className="mt-4">
            <UsersTab />
          </TabsContent>
          <TabsContent value="codes" className="mt-4">
            <CodesTab />
          </TabsContent>
          <TabsContent value="leaderboards" className="mt-4">
            <LeaderboardsTab />
          </TabsContent>
          <TabsContent value="routing" className="mt-4">
            <RoutingTab />
          </TabsContent>
          <TabsContent value="simulator" className="mt-4">
            <SimulatorTab />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
