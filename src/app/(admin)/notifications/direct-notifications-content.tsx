"use client";

import { useState } from "react";
import { Lock, Send, TriangleAlert, Users } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SectionHeading } from "@/components/modern-panels";
import { EmptyState } from "@/components/empty-state";
import { SingleNotificationForm } from "./single-notification-form";
import { BulkNotificationForm } from "./bulk-notification-form";
import type { DbEnv } from "@/lib/db-env";

type Mode = "single" | "bulk";

/**
 * The "Direct to user" tab — writes into the PERSONAL notification feed, one
 * row per recipient with its own payload. Announcements can't do that: they
 * are one row read by everyone, so they carry one shared payload.
 *
 * Sending is dev-only for now (owner directive) — the server actions enforce
 * it; this just makes the reason visible instead of failing at submit time.
 */
export function DirectNotificationsContent({
  canSend,
  dbEnv,
}: {
  canSend: boolean;
  dbEnv: DbEnv;
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

  const wrongEnv = dbEnv !== "dev";

  return (
    <div className="space-y-4">
      {wrongEnv && (
        <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
              Sending is disabled — you&apos;re pointed at {dbEnv.toUpperCase()}.
            </p>
            <p className="text-[11px] text-amber-700/80 dark:text-amber-300/80">
              These endpoints are dev-only for now. Switch the environment
              toggle in the header to DEV to send. The forms below still
              validate and show you the exact request.
            </p>
          </div>
        </div>
      )}

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
        </TabsList>
      </Tabs>

      {mode === "single" ? (
        <div className="space-y-3">
          <SectionHeading icon={Send} title="Send to one user" />
          <p className="text-xs text-muted-foreground">
            Quick smoke test. A 200 means the request was valid and the user
            exists — it can&apos;t report created vs deduped, so use a 1-item
            bulk send when you need exact accounting.
          </p>
          <SingleNotificationForm disabled={wrongEnv} />
        </div>
      ) : (
        <div className="space-y-3">
          <SectionHeading icon={Users} title="Bulk campaign" />
          <p className="text-xs text-muted-foreground">
            One row per recipient, each with its own payload. Chunked at 1000
            items (or earlier by body size) and sent one request at a time.
          </p>
          <BulkNotificationForm disabled={wrongEnv} />
        </div>
      )}
    </div>
  );
}
