"use client";

import { useState } from "react";
import { AlertTriangle, Lock, Send, Ticket, Users } from "lucide-react";
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

type Mode = "single" | "bulk" | "reward";

/**
 * The "Direct to user" tab — writes into the PERSONAL notification feed, one
 * row per recipient with its own payload. Announcements can't do that: they
 * are one row read by everyone, so they carry one shared payload.
 *
 * `ready` comes from `getDirectNotificationAvailability()`, which resolves the
 * env a send would ACTUALLY reach (not the cookie — see that module). When the
 * target backend doesn't have these endpoints, this renders the house
 * "Backend not updated yet" card instead of the composer, same as the
 * /security config cards.
 */
export function DirectNotificationsContent({
  canSend,
  ready,
  reason,
}: {
  canSend: boolean;
  ready: boolean;
  reason: string | null;
}) {
  const [mode, setMode] = useState<Mode>("single");

  if (!canSend) {
    return (
      <EmptyState
        icon={Lock}
        title="No permission to send user notifications"
        description="Needs the “Send User Notifications” capability. Ask an admin to grant it under Admins & Access → Roles."
      />
    );
  }

  if (!ready) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Direct notifications
          </CardTitle>
          <CardDescription>
            Send a personal notification into one user&apos;s feed, or run a
            bulk campaign with a per-user payload.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                {reason ??
                  "The per-user notification endpoints aren't reachable on the current backend deploy."}{" "}
                This tab becomes usable once the feature ships to the backend
                you&apos;re pointed at.
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
        <TabsList variant="line" className="self-start">
          <TabsTrigger value="single">
            <Send className="size-3.5" />
            Single user
          </TabsTrigger>
          <TabsTrigger value="bulk">
            <Users className="size-3.5" />
            Bulk campaign
          </TabsTrigger>
          <TabsTrigger value="reward">
            <Ticket className="size-3.5" />
            Reward campaign
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === "reward" ? (
        <div className="space-y-3">
          <SectionHeading icon={Ticket} title="Reward campaign" />
          <p className="text-xs text-muted-foreground">
            Set an amount and a recipient list. Every user gets their own
            single-use promo code, minted server-side and redeemable only by
            that account, delivered as a notification they can tap to copy.
          </p>
          <RewardCampaignForm />
        </div>
      ) : mode === "single" ? (
        <div className="space-y-3">
          <SectionHeading icon={Send} title="Send to one user" />
          <p className="text-xs text-muted-foreground">
            Quick smoke test. A 200 means the request was valid and the user
            exists — it can&apos;t report created vs deduped, so use a 1-item
            bulk send when you need exact accounting.
          </p>
          <SingleNotificationForm />
        </div>
      ) : (
        <div className="space-y-3">
          <SectionHeading icon={Users} title="Bulk campaign" />
          <p className="text-xs text-muted-foreground">
            One row per recipient, each with its own payload. Chunked at 1000
            items (or earlier by body size) and sent one request at a time.
          </p>
          <BulkNotificationForm />
        </div>
      )}
    </div>
  );
}
