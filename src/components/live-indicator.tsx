"use client";

import * as React from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/utils/format";
import {
  usePackyWsActiveUsers,
  usePackyWsStatus,
  type ConnectionStatus,
} from "@/lib/packy-ws";

/**
 * Global "live users" indicator for the admin top bar.
 *
 * Shows a pulsing emerald dot + the concurrent-users count broadcast by
 * the packy.gg live WebSocket (`active.users.count`). No polling — the
 * count updates as soon as the gateway sends a new value. The WS
 * singleton pauses when the tab is hidden, so background tabs don't
 * keep the socket open.
 *
 * Tooltip shows the connection status ("Connected / Reconnecting /
 * Offline") so an admin can tell the difference between "zero users"
 * and "socket is down".
 */
export function LiveIndicator() {
  const count = usePackyWsActiveUsers();
  const status = usePackyWsStatus();
  const hasLoaded = count != null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Live users online"
            title="Live users online"
            className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-600 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400"
          />
        }
      >
        {/* Dot: absolute-positioned animate-ping layer + a solid core. The
            ping layer is hidden under prefers-reduced-motion so the dot
            stays static for accessibility. Color shifts to amber when the
            WS is reconnecting, zinc when it's flat-out offline, so
            operators can eyeball connection health at a glance. */}
        <span className="relative flex size-2">
          <span
            aria-hidden
            className={`absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:hidden ${
              status === "open"
                ? "bg-emerald-500"
                : status === "reconnecting" || status === "connecting"
                  ? "bg-amber-500"
                  : "bg-zinc-500"
            }`}
          />
          <span
            className={`relative inline-flex size-2 rounded-full ${
              status === "open"
                ? "bg-emerald-500"
                : status === "reconnecting" || status === "connecting"
                  ? "bg-amber-500"
                  : "bg-zinc-500"
            }`}
          />
        </span>
        <span className="tabular-nums">
          {hasLoaded ? formatNumber(count) : "—"}
        </span>
        <span className="hidden sm:inline text-[10px] font-medium uppercase tracking-wider text-emerald-600/80 dark:text-emerald-400/80">
          online
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        <div className="flex flex-col gap-0.5 text-left">
          <span className="font-semibold">Live users</span>
          <span>
            {hasLoaded
              ? `${formatNumber(count)} currently online`
              : "Waiting for first update…"}
          </span>
          <span className="text-background/70">
            {statusLabel(status)}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function statusLabel(s: ConnectionStatus): string {
  switch (s) {
    case "open":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "closed":
      return "Offline";
  }
}
