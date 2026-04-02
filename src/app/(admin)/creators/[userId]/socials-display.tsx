"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Unlink, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Social Connections
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ALL_PLATFORMS.map((platform) => {
            const config = PLATFORM_CONFIG[platform]!;
            const social = socials.find((s) => s.platform === platform);

            if (social) {
              return (
                <div
                  key={platform}
                  className={`rounded-lg border p-4 ${config.bgColor}`}
                >
                  <p className={`text-sm font-medium ${config.color}`}>
                    {config.label}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">@{social.username}</p>
                  {social.followerCount !== null &&
                    social.followerCount > 0 && (
                      <p className="text-2xl font-bold">
                        {formatNumber(social.followerCount)}{" "}
                        <span className="text-sm font-normal text-muted-foreground">followers</span>
                      </p>
                    )}

                  <div className="mt-2 space-y-1">
                    {social.subscriberCount != null &&
                      social.subscriberCount !== social.followerCount && (
                        <StatLine
                          label="Subscribers"
                          value={formatNumber(social.subscriberCount)}
                        />
                      )}
                    {social.totalViews != null && (
                      <StatLine
                        label="Total Views"
                        value={formatNumber(social.totalViews)}
                      />
                    )}
                    {social.avgViews30d != null && (
                      <StatLine
                        label="Avg Views (30d)"
                        value={formatNumber(social.avgViews30d)}
                      />
                    )}
                    {social.avgViewers != null && (
                      <StatLine
                        label="Avg Viewers"
                        value={formatNumber(social.avgViewers)}
                      />
                    )}
                    {social.avgViewers30d != null && (
                      <StatLine
                        label="Avg Viewers (30d)"
                        value={formatNumber(social.avgViewers30d)}
                      />
                    )}
                    {social.likesAvg != null && (
                      <StatLine
                        label="Avg Likes"
                        value={formatNumber(social.likesAvg)}
                      />
                    )}
                    {social.engagementRate != null && (
                      <StatLine
                        label="Engagement"
                        value={`${(social.engagementRate * 100).toFixed(1)}%`}
                      />
                    )}
                  </div>

                  <div className="mt-2 flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-destructive hover:text-destructive"
                      onClick={() => handleUnlink(social.id)}
                      disabled={isPending}
                    >
                      <Unlink className="mr-1 size-3" />
                      Unlink
                    </Button>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={platform}
                className="rounded-lg border border-dashed p-4"
              >
                <p className={`mb-2 text-sm font-medium ${config.color}`}>
                  {config.label}
                </p>
                <div className="flex gap-1.5">
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
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function StatLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
