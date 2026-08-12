"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Crown, Inbox, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { STATUS_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useHostHref } from "@/lib/use-app-host";
import type { CreatorRewardProgramWithStats } from "@/lib/creator-vip/types";
import type { CreatorRewardClaimRow } from "@/lib/creator-vip/queries";

import { ProgramsPanel } from "./_components/programs-panel";
import { RequestsPanel } from "./_components/requests-panel";

/**
 * Creator Hub VIP reward programs + the claim review queue.
 *
 * This file is the shell only: which side is showing, and the tab bar that
 * switches it. Everything that renders a program or a claim lives in
 * `_components/`, the same layout every other Hub route uses.
 *
 * House-POV colouring throughout (CLAUDE.md): a VIP reward is money the house
 * GIVES a user, so every payout figure is ROSE. The wager that earned it is
 * money the user LOST to us, so it reads EMERALD. Pending review is neutral.
 */

export type CreatorVipTab = "programs" | "requests";
const ALL_PROGRAMS = "__all__";

export function CreatorVipContent({
  programs,
  claims,
  activeTab,
  basePath,
  creatorHrefBase = "/users",
  userHrefBase = "/users",
  claimsCap,
}: {
  programs: CreatorRewardProgramWithStats[];
  claims: CreatorRewardClaimRow[];
  /**
   * Which side is showing, resolved by the server from `?tab=` (Requests when
   * omitted). Authoritative: the tab bar below only
   * renders links, it holds no state of its own.
   */
  activeTab: CreatorVipTab;
  /** Canonical in-app path of the page the tab links point back at. */
  basePath: string;
  /**
   * Base path for links to the CREATOR who owns a program (`{base}/{userId}`).
   * Defaults to the admin `/users` profile; the Creator Hub passes
   * `/creator-hub/creators` so its surface stays self-contained. A string, not
   * a function — both consumers render this from Server Components, and
   * function props don't cross the RSC boundary.
   */
  creatorHrefBase?: string;
  /**
   * Base path for links to the PLAYER a claim belongs to (`{base}/{userId}`).
   * Split from `creatorHrefBase` because claimants are ordinary players, which
   * the Hub has no page for — it keeps the `/users` default there.
   */
  userHrefBase?: string;
  /**
   * The fetch limit the caller used for `claims`. When exactly this many rows
   * came back the list is almost certainly truncated, so the Requests panel
   * says so instead of silently presenting a capped list as complete.
   */
  claimsCap?: number;
}) {
  const uid = useId();
  const searchParams = useSearchParams();
  const [requestQuery, setRequestQuery] = useState("");
  const [requestProgramId, setRequestProgramId] = useState(ALL_PROGRAMS);
  // Host-aware, like every other Hub tab bar: `/rewards` on
  // marketing.packydash.com, `/creator-hub/rewards` on the apex. Without it a
  // tab switch bounces through the middleware's canonicalizing redirect.
  const pageHref = useHostHref(basePath);

  const pendingCount = useMemo(
    () => claims.filter((c) => c.status === "pending").length,
    [claims],
  );

  // Archived programs are history, not inventory — the tab count reflects what
  // an operator can actually act on, matching the panel's default view.
  const liveCount = programs.filter((p) => p.archivedAt == null).length;
  const requestProgramOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const claim of claims) {
      byId.set(claim.programId, claim.programName);
    }
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [claims]);
  const requestMatchingCount = useMemo(() => {
    const query = requestQuery.trim().toLowerCase();
    return claims.filter((claim) => {
      if (
        requestProgramId !== ALL_PROGRAMS &&
        claim.programId !== requestProgramId
      ) {
        return false;
      }
      if (query === "") return true;
      return (
        (claim.username ?? "").toLowerCase().includes(query) ||
        claim.userId.toLowerCase().includes(query) ||
        claim.programName.toLowerCase().includes(query)
      );
    }).length;
  }, [claims, requestProgramId, requestQuery]);

  /**
   * `?tab=` is always written explicitly on both tabs, keeping navigation and
   * Back behavior deterministic.
   */
  function hrefFor(tab: CreatorVipTab): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    return `${pageHref}?${params.toString()}`;
  }

  const tabs = [
    {
      value: "requests" as const,
      label: "Requests",
      Icon: Inbox,
      badge:
        pendingCount > 0 ? (
          <Badge
            variant="outline"
            className={cn("text-[10px]", STATUS_COLORS.pending)}
          >
            <span aria-hidden>{pendingCount}</span>
            <span className="sr-only">
              {pendingCount} claims awaiting review
            </span>
          </Badge>
        ) : null,
    },
    {
      value: "programs" as const,
      label: "Programs",
      Icon: Crown,
      badge: (
        <span className="tabular-nums text-xs text-muted-foreground">
          {liveCount}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div
          className="inline-flex w-fit shrink-0 gap-1 rounded-lg border bg-muted/50 p-1"
          role="tablist"
          aria-label="Creator rewards"
        >
          {tabs.map(({ value, label, Icon, badge }) => {
            const active = activeTab === value;
            return (
              <Link
                key={value}
                href={hrefFor(value)}
                role="tab"
                id={`${uid}-tab-${value}`}
                aria-selected={active}
                aria-controls={`${uid}-panel-${value}`}
                scroll={false}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
                {badge}
              </Link>
            );
          })}
        </div>

        {activeTab === "requests" && claims.length > 0 && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <div className="relative w-full min-w-0 sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={requestQuery}
                onChange={(event) => setRequestQuery(event.target.value)}
                placeholder="Player, user ID or program…"
                className="h-9 pl-9"
                aria-label="Search claims"
              />
            </div>
            <Select
              value={requestProgramId}
              onValueChange={(value) =>
                setRequestProgramId(value ?? ALL_PROGRAMS)
              }
            >
              <SelectTrigger
                className="h-9 w-full text-xs sm:w-[220px]"
                aria-label="Filter by program"
              >
                <SelectValue>
                  {requestProgramId === ALL_PROGRAMS
                    ? "All programs"
                    : (requestProgramOptions.find(
                        ([id]) => id === requestProgramId,
                      )?.[1] ?? "All programs")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROGRAMS}>All programs</SelectItem>
                {requestProgramOptions.map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs tabular-nums text-muted-foreground lg:ml-auto">
              {requestMatchingCount} of {claims.length}
            </span>
          </div>
        )}
      </div>

      {activeTab === "programs" ? (
        <div
          role="tabpanel"
          id={`${uid}-panel-programs`}
          aria-labelledby={`${uid}-tab-programs`}
        >
          <ProgramsPanel programs={programs} creatorHrefBase={creatorHrefBase} />
        </div>
      ) : (
        <div
          role="tabpanel"
          id={`${uid}-panel-requests`}
          aria-labelledby={`${uid}-tab-requests`}
        >
          <RequestsPanel
            claims={claims}
            userHrefBase={userHrefBase}
            claimsCap={claimsCap}
            query={requestQuery}
            programId={requestProgramId}
            onClearFilters={() => {
              setRequestQuery("");
              setRequestProgramId(ALL_PROGRAMS);
            }}
          />
        </div>
      )}
    </div>
  );
}
