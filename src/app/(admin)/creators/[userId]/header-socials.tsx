"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { SocialsDisplay } from "./socials-display";

type SocialLike = {
  id: string;
  platform: string;
  username: string;
  followerCount: number | null;
  subscriberCount?: number | null;
  totalViews?: number | null;
  avgViews30d?: number | null;
  avgViewers?: number | null;
  avgViewers30d?: number | null;
  engagementRate?: number | null;
  likesAvg?: number | null;
  lastFetchedAt: string | null;
};

// Platform → accent colour + compact label. Matches the hues used on the
// full SocialsDisplay card so the header chip reads as "the same account,
// just smaller", not a different visual language.
const PLATFORM_META: Record<
  string,
  { label: string; color: string; bg: string; border: string }
> = {
  twitter: {
    label: "X",
    color: "text-sky-500",
    bg: "bg-sky-500/10",
    border: "border-sky-500/20",
  },
  youtube: {
    label: "YT",
    color: "text-red-500",
    bg: "bg-red-500/10",
    border: "border-red-500/20",
  },
  kick: {
    label: "Kick",
    color: "text-green-500",
    bg: "bg-green-500/10",
    border: "border-green-500/20",
  },
  instagram: {
    label: "IG",
    color: "text-pink-500",
    bg: "bg-pink-500/10",
    border: "border-pink-500/20",
  },
  discord: {
    label: "DC",
    color: "text-indigo-500",
    bg: "bg-indigo-500/10",
    border: "border-indigo-500/20",
  },
};

export function HeaderSocials({
  socials,
  userId,
}: {
  socials: SocialLike[];
  userId: string;
}) {
  const [open, setOpen] = useState(false);
  const connected = socials.filter((s) => s.username);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="flex flex-wrap items-center gap-1.5">
        {connected.map((s) => {
          const meta = PLATFORM_META[s.platform] ?? {
            label: s.platform,
            color: "text-muted-foreground",
            bg: "bg-muted",
            border: "border-border",
          };
          const count = s.followerCount ?? s.subscriberCount ?? null;
          return (
            <span
              key={s.platform}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px]",
                meta.bg,
                meta.border,
              )}
            >
              <span className={cn("font-semibold", meta.color)}>
                {meta.label}
              </span>
              <span className="text-muted-foreground">@{s.username}</span>
              {count != null && count > 0 ? (
                <span className="font-medium tabular-nums">
                  {formatNumber(count)}
                </span>
              ) : null}
            </span>
          );
        })}

        <DialogTrigger
          render={
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              )}
              aria-label={
                connected.length === 0 ? "Link socials" : "Manage socials"
              }
            />
          }
        >
          {connected.length === 0 ? (
            <>
              <Plus className="size-3" />
              Link socials
            </>
          ) : (
            <>
              <Pencil className="size-3" />
              Manage
            </>
          )}
        </DialogTrigger>
      </div>

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">
            Social connections
          </DialogTitle>
        </DialogHeader>
        {/* Reuse the full SocialsDisplay widget inside the dialog so the
            admin-only link/unlink + detailed stats UI stays in one place.
            The SocialsDisplay component wraps itself in a Card, but inside
            a modal that's fine — it scopes the content visually. */}
        <SocialsDisplay socials={socials} userId={userId} />
      </DialogContent>
    </Dialog>
  );
}
