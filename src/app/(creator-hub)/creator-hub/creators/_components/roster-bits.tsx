import {
  ClipboardList,
  Instagram,
  MessageCircle,
  Music2,
  Twitch,
  Youtube,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CreatorSocialPlatform } from "@/lib/backend-api";

import type { RosterCreator } from "../_queries/list-roster-creators";

/**
 * Roster bits — tiny presentational helpers shared by the roster card (grid
 * view, server-rendered) and the roster table (list view, client-rendered).
 * Previously duplicated verbatim across `roster-card.tsx` and
 * `roster-grid.tsx`; extracted so the two views can't drift.
 *
 * No `"use client"` and no hooks — pure markup + pure functions, importable
 * from both sides of the RSC boundary. Type-only imports from the (server-
 * only) query module are erased at compile time, so nothing server-only leaks
 * into the client bundle.
 */

/** Two-letter avatar-fallback initials. */
export function initials(name: string | null): string {
  const clean = (name ?? "").trim();
  if (!clean) return "?";
  return clean.slice(0, 2).toUpperCase();
}

/** House-POV signed money class: positive = emerald, negative = rose. */
export function signedHouseClass(value: number | null): string {
  if (value == null || value === 0) return "text-muted-foreground";
  return value > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
}

/** Canonical detail-page href for a roster creator. */
export function CreatorHref(id: string): string {
  return `/creator-hub/creators/${id}`;
}

/**
 * Social platform metadata for the roster chips/icons. Flat idiom: the GLYPH
 * carries the platform hue — chip backgrounds stay neutral.
 */
export const PLATFORM_META: Record<
  CreatorSocialPlatform,
  { icon: LucideIcon; glyphClass: string; label: string }
> = {
  twitch: {
    icon: Twitch,
    glyphClass: "text-purple-600 dark:text-purple-400",
    label: "Twitch",
  },
  youtube: {
    icon: Youtube,
    glyphClass: "text-rose-600 dark:text-rose-400",
    label: "YouTube",
  },
  kick: {
    icon: Twitch,
    glyphClass: "text-emerald-600 dark:text-emerald-400",
    label: "Kick",
  },
  x: {
    icon: MessageCircle,
    glyphClass: "text-zinc-700 dark:text-zinc-300",
    label: "X",
  },
  instagram: {
    icon: Instagram,
    glyphClass: "text-pink-600 dark:text-pink-400",
    label: "Instagram",
  },
  tiktok: {
    icon: Music2,
    glyphClass: "text-cyan-600 dark:text-cyan-400",
    label: "TikTok",
  },
  discord: {
    icon: MessageCircle,
    glyphClass: "text-indigo-600 dark:text-indigo-400",
    label: "Discord",
  },
};

export function ExCreatorBadge() {
  return (
    <Badge
      variant="outline"
      className="h-5 shrink-0 border-purple-500/40 bg-purple-500/10 py-0 text-[10px] font-medium text-purple-600 dark:text-purple-400"
      title="Previously had the creator role — role since removed"
    >
      Ex-creator
    </Badge>
  );
}

/**
 * Standard live pulse dot — the house ping idiom (relative dot + absolute
 * `animate-ping` halo). Replaces the old hardcoded rgba box-shadow pulse.
 */
export function LiveDot() {
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden>
      <span className="absolute inline-flex size-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />
      <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
    </span>
  );
}

export function LiveBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
      <LiveDot />
      LIVE
    </span>
  );
}

export function DealStatusBadge({
  status,
}: {
  status: RosterCreator["dealStatus"];
}) {
  if (status == null) return null;
  const map: Record<string, string> = {
    active:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    scheduled:
      "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    completed: "border-muted bg-muted/50 text-muted-foreground",
    terminated:
      "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  };
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 capitalize", map[status] ?? "")}
    >
      {status}
    </Badge>
  );
}

/**
 * Compact onboarding-progress pill ("5/8"). Pure presentation over the
 * batched roster checklist data — no per-card query, no Suspense island.
 */
export function ChecklistPill({
  progress,
  className,
}: {
  progress: { doneCount: number; totalCount: number };
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary",
        className,
      )}
      title={`Onboarding: ${progress.doneCount} of ${progress.totalCount} steps done`}
    >
      <ClipboardList className="size-3" />
      <span className="tabular-nums">
        {progress.doneCount}/{progress.totalCount}
      </span>
    </span>
  );
}
