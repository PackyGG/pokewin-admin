"use client";

import { useMemo, useState, useTransition } from "react";
import { Activity, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ux";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  COMMUNITY_RANKS,
  type CommunityLevelRole,
} from "@/lib/discord-community-ranks";
import type { CommunityXpDashboard } from "@/lib/discord-community-xp";

import { updateDiscordCommunityRanksAction } from "./actions";
import { DiscordCommunityXpDashboard } from "./discord-community-xp-dashboard";

function roleMap(roles: CommunityLevelRole[]): Record<string, string> {
  return Object.fromEntries(roles.map((role) => [String(role.level), role.roleId]));
}

export function DiscordCommunityXpCard({
  initialRoles,
  dashboard,
  dashboardFailureKind = null,
}: {
  initialRoles: CommunityLevelRole[];
  /** `null` when the stats read degraded — the rank-role editor still works. */
  dashboard: CommunityXpDashboard | null;
  dashboardFailureKind?: "timeout" | "error" | null;
}) {
  const [isPending, startTransition] = useTransition();
  const [roleIds, setRoleIds] = useState(() => roleMap(initialRoles));
  const configured = useMemo(
    () => COMMUNITY_RANKS.filter((rank) => roleIds[String(rank.level)]?.trim()).length,
    [roleIds],
  );

  const save = () => {
    startTransition(async () => {
      const result = await updateDiscordCommunityRanksAction(roleIds);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setRoleIds(roleMap(result.roles));
      toast.success("Community rank roles saved");
    });
  };

  return (
    <div className="space-y-5">
      {dashboard ? (
        <DiscordCommunityXpDashboard data={dashboard} />
      ) : (
        <TileErrorFallback
          label="Community XP stats"
          hint="The XP statistics read degraded — refresh to retry. Rank-role settings below are unaffected."
          kind={dashboardFailureKind ?? "error"}
          size="panel"
        />
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="size-5 text-primary" />
            <CardTitle>Community XP</CardTitle>
          </div>
          <CardDescription>
            Discord and linked Packy chat activity share one level, leaderboard position, and rank.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Award", "15 XP", "Per qualifying message"],
              ["Cooldown", "3–10 sec", "Separately per source"],
              ["Duplicate filter", "3 min", "Same normalized content"],
              ["Daily cap", "None", "Quality rules still apply"],
            ].map(([label, value, detail]) => (
              <div key={label} className="rounded-xl border bg-muted/20 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
                <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
              </div>
            ))}
          </div>

          <div className="rounded-xl border p-4">
            <p className="font-medium">Public Discord commands</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {["/profile", "/ranks", "/lb"].map((command) => (
                <code key={command} className="rounded-md bg-muted px-2.5 py-1 text-sm">{command}</code>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              /profile is self-only. Rank-role administration lives on this page instead of in Discord.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Rank roles</CardTitle>
              <CardDescription className="mt-1">
                Paste each Discord role ID. Empty rows are not assigned. Members keep only their highest earned rank.
              </CardDescription>
            </div>
            <span className="text-sm text-muted-foreground">{configured}/{COMMUNITY_RANKS.length} configured</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-2">
            {COMMUNITY_RANKS.map((rank) => {
              const xp = rank.level * rank.level * 100;
              return (
                <label key={rank.level} className="flex items-center gap-3 rounded-xl border p-3">
                  <span
                    className="size-3 shrink-0 rounded-full ring-4 ring-muted"
                    style={{ backgroundColor: rank.color }}
                  />
                  <span className="min-w-32">
                    <span className="block font-medium">{rank.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      Level {rank.level} · {xp.toLocaleString()} XP
                    </span>
                  </span>
                  <Input
                    aria-label={`${rank.name} Discord role ID`}
                    inputMode="numeric"
                    maxLength={20}
                    placeholder="Discord role ID"
                    value={roleIds[String(rank.level)] ?? ""}
                    disabled={isPending}
                    onChange={(event) => setRoleIds((current) => ({
                      ...current,
                      [String(rank.level)]: event.target.value.replace(/\D/g, ""),
                    }))}
                  />
                </label>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Role changes are applied by the bot’s hourly reconciliation worker.
            </p>
            <Button onClick={save} disabled={isPending}>
              {isPending ? <Spinner size={15} className="text-current" /> : <Save className="size-4" />}
              {isPending ? "Saving..." : "Save rank roles"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
