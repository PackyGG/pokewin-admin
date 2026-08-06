"use client";

import { useId, useMemo, useState } from "react";
import { Crown, Inbox } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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
  initialTab,
  creatorHrefBase = "/users",
  userHrefBase = "/users",
  claimsCap,
}: {
  programs: CreatorRewardProgramWithStats[];
  claims: CreatorRewardClaimRow[];
  /**
   * Deep-link override for the initial tab (e.g. driven from `?tab=` by the
   * Creator Hub surface). When absent, the original behavior applies: land on
   * Requests if claims are waiting, otherwise Programs.
   */
  initialTab?: CreatorVipTab;
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
  const pending = useMemo(
    () => claims.filter((c) => c.status === "pending"),
    [claims],
  );
  // Land on whichever side needs attention — an operator opening this tab with
  // claims waiting almost certainly came to review them, not to read config.
  const [subTab, setSubTab] = useState<CreatorVipTab>(
    initialTab ?? (pending.length > 0 ? "requests" : "programs"),
  );

  // Archived programs are history, not inventory — the tab count reflects what
  // an operator can actually act on, matching the panel's default view.
  const liveCount = programs.filter((p) => p.archivedAt == null).length;

  return (
    <div className="space-y-4">
      <div className="inline-flex gap-1 rounded-lg bg-muted p-1" role="tablist">
        <button
          type="button"
          role="tab"
          id={`${uid}-tab-programs`}
          aria-selected={subTab === "programs"}
          aria-controls={`${uid}-panel-programs`}
          onClick={() => setSubTab("programs")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            subTab === "programs"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Crown className="size-4" aria-hidden />
          Programs
          <span className="tabular-nums text-xs text-muted-foreground">
            {liveCount}
          </span>
        </button>
        <button
          type="button"
          role="tab"
          id={`${uid}-tab-requests`}
          aria-selected={subTab === "requests"}
          aria-controls={`${uid}-panel-requests`}
          onClick={() => setSubTab("requests")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            subTab === "requests"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Inbox className="size-4" aria-hidden />
          Requests
          {pending.length > 0 && (
            <Badge
              variant="outline"
              className="bg-amber-500/15 text-[10px] text-amber-600 dark:text-amber-400"
            >
              <span aria-hidden>{pending.length}</span>
              <span className="sr-only">
                {pending.length} claims awaiting review
              </span>
            </Badge>
          )}
        </button>
      </div>

      {subTab === "programs" ? (
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
