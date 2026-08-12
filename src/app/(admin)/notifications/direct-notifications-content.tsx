"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Gift,
  Lock,
  MessageSquareText,
  Package,
  Trophy,
  Users,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SectionHeading } from "@/components/modern-panels";
import { EmptyState } from "@/components/empty-state";
import { SingleNotificationForm } from "./single-notification-form";
import { BulkNotificationForm } from "./bulk-notification-form";
import { RewardCampaignForm } from "./reward-campaign-form";
import type { DbEnv } from "@/lib/db-env";

type Mode = "message" | "pack" | "challenge" | "reward" | "bulk";

const COMPOSER_OPTIONS = [
  {
    value: "message",
    label: "Message",
    description: "Write a title and message",
    icon: MessageSquareText,
  },
  {
    value: "pack",
    label: "Pack",
    description: "Share up to three packs",
    icon: Package,
  },
  {
    value: "challenge",
    label: "Challenge",
    description: "Promote a live challenge",
    icon: Trophy,
  },
  {
    value: "reward",
    label: "Reward",
    description: "Send single-use rewards",
    icon: Gift,
  },
  {
    value: "bulk",
    label: "Bulk",
    description: "Message a list of users",
    icon: Users,
  },
] as const;

/**
 * The "Direct to user" tab — writes into the PERSONAL notification feed, one
 * row per recipient with its own payload. Announcements can't do that: they
 * are one row read by everyone, so they carry one shared payload.
 *
 * `ready` comes from `getDirectNotificationAvailability()`, which resolves the
 * env a send would ACTUALLY reach (not the cookie — see that module). When the
 * target backend is not configured, this renders an unavailable card instead
 * of a composer that could fail after an operator prepares a campaign.
 */
export function DirectNotificationsContent({
  canSend,
  backendEnv,
  ready,
  reason,
}: {
  canSend: boolean;
  backendEnv: DbEnv | null;
  ready: boolean;
  reason: string | null;
}) {
  const [mode, setMode] = useState<Mode>("message");

  if (!canSend) {
    return (
      <EmptyState
        icon={Lock}
        title="No permission to send user notifications"
        description="Needs the “Send User Notifications” capability. Ask an admin to grant it under Admins & Access → Roles."
      />
    );
  }

  if (!ready || !backendEnv) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Direct notifications
          </CardTitle>
          <CardDescription>
            Send a personal message, pack, challenge, reward, or bulk update.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">Direct sending is unavailable</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                {reason ??
                  "The selected backend does not have a complete API configuration."}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Tabs value={mode} onValueChange={(v: string) => setMode(v as Mode)}>
        <TabsList className="grid h-auto w-full grid-cols-2 gap-2 bg-transparent p-0 sm:grid-cols-3 xl:grid-cols-5">
          {COMPOSER_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <TabsTrigger
                key={option.value}
                value={option.value}
                className="group h-auto min-h-20 items-start justify-start gap-3 whitespace-normal rounded-lg border bg-card p-3 text-left shadow-none data-active:border-primary data-active:bg-primary/5 data-active:shadow-none"
              >
                <span className="rounded-md bg-muted p-2 text-muted-foreground group-data-active:text-primary">
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 space-y-0.5">
                  <span className="block text-sm font-medium text-foreground">
                    {option.label}
                  </span>
                  <span className="block text-[11px] font-normal leading-snug text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {mode === "reward" ? (
        <div className="space-y-3">
          <SectionHeading icon={Gift} title="Send rewards" />
          <p className="text-xs text-muted-foreground">
            Set an amount and a recipient list. Every user gets their own
            single-use promo code, minted server-side and redeemable only by
            that account, delivered as a notification they can tap to copy.
          </p>
          <RewardCampaignForm targetEnv={backendEnv} />
        </div>
      ) : mode === "bulk" ? (
        <div className="space-y-3">
          <SectionHeading icon={Users} title="Send a bulk message" />
          <p className="text-xs text-muted-foreground">
            Paste user IDs, write the title and message once, then review and
            send. Batching and safe retries are handled automatically.
          </p>
          <BulkNotificationForm targetEnv={backendEnv} />
        </div>
      ) : (
        <div className="space-y-3">
          <SectionHeading
            icon={
              mode === "pack"
                ? Package
                : mode === "challenge"
                  ? Trophy
                  : MessageSquareText
            }
            title={
              mode === "pack"
                ? "Send packs"
                : mode === "challenge"
                  ? "Send a challenge"
                  : "Send a message"
            }
          />
          <p className="text-xs text-muted-foreground">
            {mode === "pack"
              ? "Choose a user and the packs to feature. Names, prices, images, and links are filled in for you."
              : mode === "challenge"
                ? "Choose a user, game, challenge name, and optional prize."
                : "Choose a user, then write exactly the title and message they should see."}
          </p>
          <SingleNotificationForm key={mode} mode={mode} />
        </div>
      )}
    </div>
  );
}
