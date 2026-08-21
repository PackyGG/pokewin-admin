"use client";

import { useState, type ReactNode } from "react";
import {
  BarChart3,
  CheckCircle2,
  Globe2,
  Radar,
  ShieldAlert,
  UserRoundCog,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  EosTestConfig,
  EosUserConfig,
} from "@/lib/antifraud/eos-test-config-api";
import { EosPlayerIntelligencePanel } from "./eos-player-intelligence";
import { EosTestConfigCard } from "./eos-test-config-card";
import { EosUserSequences } from "./eos-user-sequences";

type FocusedUser = {
  userId: string;
  username: string | null;
  displayUsername: string | null;
};

export function EosWorkspace({
  environment,
  config,
  userConfigs,
  overview,
}: {
  environment: EosTestConfig["environment"];
  config: EosTestConfig;
  userConfigs: EosUserConfig[];
  overview: ReactNode;
}) {
  const [tab, setTab] = useState("global");
  const [focusedUser, setFocusedUser] = useState<FocusedUser | null>(null);
  const activePersonalFlows = userConfigs.filter((entry) =>
    entry.enabled || entry.forceLosses
  ).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card size="sm">
          <CardContent className="flex items-center gap-3">
            <span className="rounded-lg bg-emerald-500/10 p-2 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-4" />
            </span>
            <div>
              <p className="text-xs text-muted-foreground">Control service</p>
              <p className="font-semibold">Connected to {environment}</p>
            </div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="flex items-center gap-3">
            <span className="rounded-lg bg-primary/10 p-2 text-primary"><Globe2 className="size-4" /></span>
            <div>
              <p className="text-xs text-muted-foreground">Global flow</p>
              <p className="font-semibold">{config.enabled ? "Running" : "Paused"}</p>
            </div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="flex items-center gap-3">
            <span className="rounded-lg bg-primary/10 p-2 text-primary"><UserRoundCog className="size-4" /></span>
            <div>
              <p className="text-xs text-muted-foreground">Personal controls</p>
              <p className="font-semibold tabular-nums">{activePersonalFlows} active · {userConfigs.length} saved</p>
            </div>
          </CardContent>
        </Card>
        <Card size="sm" className={config.forceAllLosses ? "ring-destructive/60" : undefined}>
          <CardContent className="flex items-center gap-3">
            <span className={config.forceAllLosses
              ? "rounded-lg bg-destructive/10 p-2 text-destructive"
              : "rounded-lg bg-muted p-2 text-muted-foreground"}
            >
              <ShieldAlert className="size-4" />
            </span>
            <div>
              <p className="text-xs text-muted-foreground">All-battles override</p>
              <p className="font-semibold">{config.forceAllLosses ? "Force loss active" : "Off"}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList className="no-scrollbar h-10 w-full justify-start overflow-x-auto sm:w-fit">
          <TabsTrigger value="global" className="px-4">
            <Globe2 className="size-4" />Global
          </TabsTrigger>
          <TabsTrigger value="users" className="px-4">
            <UserRoundCog className="size-4" />Per-user
          </TabsTrigger>
          <TabsTrigger value="signals" className="px-4">
            <Radar className="size-4" />Player signals
          </TabsTrigger>
          <TabsTrigger value="overview" className="px-4">
            <BarChart3 className="size-4" />Impact overview
          </TabsTrigger>
        </TabsList>
        <TabsContent value="global">
          <EosTestConfigCard initial={config} />
        </TabsContent>
        <TabsContent value="users">
          <EosUserSequences
            key={focusedUser?.userId ?? "no-focused-user"}
            environment={environment}
            initial={userConfigs}
            forceAllLosses={config.forceAllLosses}
            focusUser={focusedUser}
          />
        </TabsContent>
        <TabsContent value="signals">
          <EosPlayerIntelligencePanel
            active={tab === "signals"}
            configuredUsers={userConfigs}
            onConfigure={(player) => {
              setFocusedUser({
                userId: player.userId,
                username: player.username,
                displayUsername: player.username,
              });
              setTab("users");
            }}
          />
        </TabsContent>
        <TabsContent value="overview">
          {overview}
        </TabsContent>
      </Tabs>
      <p className="text-center text-[11px] text-muted-foreground">
        Multiplier ranges use creator payout ÷ creator cost. Ordered win/loss steps retry
        when the five-block EOS window cannot provide the requested outcome.
      </p>
      {config.forceAllLosses ? (
        <Badge variant="destructive" className="fixed bottom-4 right-4 z-40 shadow-lg">
          Global force-loss override active
        </Badge>
      ) : null}
    </div>
  );
}
