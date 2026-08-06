"use client";

import { useId, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Crown, Inbox } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
   * Which side is showing, resolved by the server from `?tab=` (falling back
   * to whichever side needs attention). Authoritative: the tab bar below only
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

  /**
   * `?tab=` is always written explicitly, on both tabs. The no-param default is
   * data-dependent (land on Requests when claims are waiting), so a bare href
   * would mean "whatever the queue looks like right now" rather than the tab
   * the operator just clicked.
   */
  function hrefFor(tab: CreatorVipTab): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    return `${pageHref}?${params.toString()}`;
  }

  const tabs = [
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
  ];

  return (
    <div className="space-y-4">
      <div
        className="inline-flex gap-1 rounded-lg border bg-muted/50 p-1"
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
              // Pushed, not replaced (the roster switch replaces): Back was the
              // gap this tab bar was fixing, and a reviewer who deep-linked
              // into Requests expects Back to return to Programs.
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
          />
        </div>
      )}
    </div>
  );
}
