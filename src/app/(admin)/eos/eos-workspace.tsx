"use client";

import { useState, type ReactNode } from "react";
import {
  BarChart3,
  CheckCircle2,
  Globe2,
  Radar,
  Route,
  ShieldAlert,
  Swords,
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
    value: "battles",
    label: "Battles",
    description: "Outcomes & controls",
    icon: Swords,
  },
  {
    value: "global",
    label: "Global",
    description: "Site-wide flow",
    icon: Globe2,
  },
  {
    value: "users",
    label: "Per-user",
    description: "Personal flows",
    icon: UserRoundCog,
  },
  {
    value: "signals",
    label: "Intelligence",
    description: "Player rankings",
    icon: Radar,
  },
  {
    value: "overview",
    label: "Results",
    description: "Control impact",
    icon: BarChart3,
  },
] as const satisfies ReadonlyArray<{
  value: WorkspaceTab;
  label: string;
  description: string;
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
      <Card
        size="sm"
        className={config.forceAllLosses
          ? "gap-0 bg-destructive/[0.035] ring-destructive/45"
          : "gap-0"}
      >
        <CardContent className="px-0">
          <div className="flex flex-col gap-3 px-4 pb-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold">EOS controls online</p>
                  <Badge variant="outline" className="h-5 text-[10px] uppercase tracking-wide">
                    {environmentLabel}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Connected to the {environmentLabel.toLowerCase()} control service
                </p>
              </div>
            </div>
            {config.forceAllLosses ? (
              <Badge variant="destructive" className="w-fit gap-1.5 py-1">
                <ShieldAlert className="size-3.5" aria-hidden="true" />
                Force-loss override active
              </Badge>
            ) : (
              <Badge variant="secondary" className="w-fit gap-1.5 py-1">
                <CheckCircle2 className="size-3.5" aria-hidden="true" />
                Emergency override off
              </Badge>
            )}
          </div>

          <div className="grid border-t sm:grid-cols-3 sm:divide-x">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:border-b-0">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Global fallback
                </p>
                <p className="mt-0.5 text-sm font-semibold">
                  {config.enabled ? "Running" : "Paused"}
                </p>
              </div>
              <span
                className={config.enabled
                  ? "size-2 rounded-full bg-emerald-500"
                  : "size-2 rounded-full bg-muted-foreground/45"}
                aria-label={config.enabled ? "Running" : "Paused"}
                role="img"
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:border-b-0">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Personal controls
                </p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums">
                  {activePersonalFlows} active
                  <span className="font-normal text-muted-foreground"> · {userConfigs.length} saved</span>
                </p>
              </div>
              <UserRoundCog className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="flex items-center gap-3 px-4 py-3">
              <Route className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Decision priority
                </p>
                <p className="mt-0.5 truncate text-sm font-medium">
                  {config.forceAllLosses
                    ? "Emergency override → loss or lowest fallback"
                    : "Personal → global → random"}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as WorkspaceTab)}
        className="min-w-0 gap-4"
      >
        <TabsList
          aria-label="EOS workspace sections"
          className="grid h-auto w-full grid-cols-2 gap-1 rounded-xl p-1 sm:grid-cols-5"
        >
          {WORKSPACE_TABS.map(({ value, label, description, icon: Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="h-auto min-w-0 justify-start gap-2 px-3 py-2 text-left sm:justify-center xl:justify-start"
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block truncate leading-5">{label}</span>
                <span className="hidden truncate text-[10px] font-normal leading-3 text-muted-foreground xl:block">
                  {description}
                </span>
              </span>
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
