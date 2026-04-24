"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Unlink, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatNumber } from "@/lib/utils/format";
import {
  adminLinkSocialByUsername,
  adminUnlinkSocial,
} from "../actions";

type Social = {
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

const PLATFORM_CONFIG: Record<
  string,
  { label: string; color: string; bgColor: string; placeholder: string }
> = {
  twitter: {
    label: "Twitter / X",
    color: "text-sky-500",
    bgColor: "bg-sky-500/10 border-sky-500/20",
    placeholder: "elonmusk",
  },
  youtube: {
    label: "YouTube",
    color: "text-red-500",
    bgColor: "bg-red-500/10 border-red-500/20",
    placeholder: "MrBeast",
  },
  kick: {
    label: "Kick",
    color: "text-green-500",
    bgColor: "bg-green-500/10 border-green-500/20",
    placeholder: "xqc",
  },
  instagram: {
    label: "Instagram",
    color: "text-pink-500",
    bgColor: "bg-pink-500/10 border-pink-500/20",
    placeholder: "instagram",
  },
};

const ALL_PLATFORMS = ["twitter", "youtube", "kick", "instagram"];

export function SocialsDisplay({
  socials,
  userId,
}: {
  socials: Social[];
  userId: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const router = useRouter();

  function handleLink(platform: string) {
    const username = inputs[platform]?.trim();
    if (!username) {
      toast.error("Enter a username");
      return;
    }
    startTransition(async () => {
      try {
        const count = await adminLinkSocialByUsername(userId, platform, username);
        toast.success(
          count !== null
            ? `Linked! ${formatNumber(count)} followers`
            : "Linked successfully"
        );
        setInputs((prev) => ({ ...prev, [platform]: "" }));
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to link account");
      }
    });
  }

  function handleUnlink(socialId: string) {
    startTransition(async () => {
      try {
        await adminUnlinkSocial(userId, socialId);
        toast.success("Account unlinked");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to unlink");
      }
    });
  }

  // One row per platform, stacked vertically. Used inside the header
  // "Manage socials" dialog — single-column layout reads linearly and
  // keeps connected + unconnected platforms visually consistent.
  return (
    <ul className="divide-y divide-border/60">
      {ALL_PLATFORMS.map((platform) => {
        const config = PLATFORM_CONFIG[platform]!;
        const social = socials.find((s) => s.platform === platform);

        return (
          <li key={platform} className="py-3 first:pt-0 last:pb-0">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className={`text-sm font-semibold ${config.color}`}>
                    {config.label}
                  </span>
                  {social ? (
                    <span className="text-xs text-muted-foreground">
                      @{social.username}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Not linked
                    </span>
                  )}
                </div>

                {social ? (
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                    {social.followerCount != null && social.followerCount > 0 && (
                      <StatInline
                        label="Followers"
                        value={formatNumber(social.followerCount)}
                      />
                    )}
                    {social.subscriberCount != null &&
                      social.subscriberCount !== social.followerCount && (
                        <StatInline
                          label="Subs"
                          value={formatNumber(social.subscriberCount)}
                        />
                      )}
                    {social.totalViews != null && (
                      <StatInline
                        label="Views"
                        value={formatNumber(social.totalViews)}
                      />
                    )}
                    {social.avgViews30d != null && (
                      <StatInline
                        label="Avg views 30d"
                        value={formatNumber(social.avgViews30d)}
                      />
                    )}
                    {social.avgViewers != null && (
                      <StatInline
                        label="Avg viewers"
                        value={formatNumber(social.avgViewers)}
                      />
                    )}
                    {social.avgViewers30d != null && (
                      <StatInline
                        label="Avg viewers 30d"
                        value={formatNumber(social.avgViewers30d)}
                      />
                    )}
                    {social.likesAvg != null && (
                      <StatInline
                        label="Avg likes"
                        value={formatNumber(social.likesAvg)}
                      />
                    )}
                    {social.engagementRate != null && (
                      <StatInline
                        label="Engagement"
                        value={`${(social.engagementRate * 100).toFixed(1)}%`}
                      />
                    )}
                  </div>
                ) : (
                  <div className="mt-1.5 flex gap-1.5">
                    <Input
                      placeholder={config.placeholder}
                      value={inputs[platform] ?? ""}
                      onChange={(e) =>
                        setInputs((prev) => ({
                          ...prev,
                          [platform]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => e.key === "Enter" && handleLink(platform)}
                      className="h-8 text-xs"
                      disabled={isPending}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-8 shrink-0"
                      onClick={() => handleLink(platform)}
                      disabled={isPending}
                    >
                      <Check className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>

              {social ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 text-xs text-destructive hover:text-destructive"
                  onClick={() => handleUnlink(social.id)}
                  disabled={isPending}
                >
                  <Unlink className="mr-1 size-3" />
                  Unlink
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function StatInline({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </span>
  );
}

