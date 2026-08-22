"use client";

import { useState, type ReactNode } from "react";
import {
  BarChart3,
  Globe2,
  Radar,
  Route,
  ShieldAlert,
  Swords,
  UserRoundCog,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type {
  EosTestConfig,
  EosUserConfig,
} from "@/lib/antifraud/eos-test-config-api";
import { EosPlayerIntelligencePanel } from "./eos-player-intelligence";
import { EosBattles } from "./eos-battles";
import { EosTestConfigCard } from "./eos-test-config-card";
import { EosUserSequences } from "./eos-user-sequences";

type FocusedUser = {
  userId: string;
  username: string | null;
  displayUsername: string | null;
};

type WorkspaceTab = "global" | "users" | "battles" | "signals" | "overview";

const WORKSPACE_TABS = [
  {
    value: "global",
    label: "Global",
    icon: Globe2,
  },
  {
    value: "users",
    label: "Per-user",
    icon: UserRoundCog,
  },
  {
    value: "battles",
    label: "Battles",
    icon: Swords,
  },
  {
    value: "signals",
    label: "Intelligence",
    icon: Radar,
  },
  {
    value: "overview",
    label: "Results",
    icon: BarChart3,
  },
] as const satisfies ReadonlyArray<{
  value: WorkspaceTab;
  label: string;
  icon: typeof Globe2;
}>;

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
  const [tab, setTab] = useState<WorkspaceTab>("global");
  const [focusedUser, setFocusedUser] = useState<FocusedUser | null>(null);
  const activePersonalFlows = userConfigs.filter((entry) =>
    entry.enabled || entry.forceLosses
  ).length;
  const environmentLabel = environment === "prod" ? "Production" : "Development";

  return (
    <div className="min-w-0 space-y-4">
      <div
        className={cn(
          "flex flex-col gap-3 rounded-xl border bg-card px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4",
          config.forceAllLosses && "border-destructive/40 bg-destructive/[0.035]",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative flex size-2 shrink-0" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">EOS controls online</p>
              <Badge
                variant="outline"
                className="h-5 text-[10px] uppercase tracking-[0.12em]"
              >
                {environmentLabel}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {config.forceAllLosses
                ? "Emergency override → loss or lowest fallback"
                : "Personal flow → global flow → random outcome"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary" className="gap-1.5 font-medium">
            <Route className="size-3" aria-hidden="true" />
            Global {config.enabled ? "running" : "paused"}
          </Badge>
          <Badge variant="secondary" className="gap-1.5 font-medium tabular-nums">
            <UserRoundCog className="size-3" aria-hidden="true" />
            {activePersonalFlows} personal active
          </Badge>
          {config.forceAllLosses && (
            <Badge variant="destructive" className="gap-1.5 font-medium">
              <ShieldAlert className="size-3" aria-hidden="true" />
              Force-loss active
            </Badge>
          )}
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as WorkspaceTab)}
        className="min-w-0 gap-4"
      >
        <TabsList
          variant="line"
          aria-label="EOS workspace sections"
          className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {WORKSPACE_TABS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="h-10 flex-none gap-2 px-3 sm:px-4"
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span>{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="global" className="min-w-0">
          <EosTestConfigCard initial={config} />
        </TabsContent>
        <TabsContent value="users" className="min-w-0">
          <EosUserSequences
            key={focusedUser?.userId ?? "no-focused-user"}
            environment={environment}
            initial={userConfigs}
            forceAllLosses={config.forceAllLosses}
            focusUser={focusedUser}
          />
        </TabsContent>
        <TabsContent value="signals" className="min-w-0">
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
        <TabsContent value="battles" className="min-w-0">
          <EosBattles active={tab === "battles"} />
        </TabsContent>
        <TabsContent value="overview" className="min-w-0">
          {overview}
        </TabsContent>
      </Tabs>
      <p className="px-1 text-xs leading-5 text-muted-foreground">
        Multiplier = creator payout ÷ creator cost. Ordered outcome steps retry when the
        five-block EOS window cannot satisfy the requested win or loss.
      </p>
    </div>
  );
}
