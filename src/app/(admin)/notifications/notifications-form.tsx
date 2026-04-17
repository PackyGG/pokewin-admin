"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { TILE_COLORS } from "@/components/modern-panels";
import type { NotificationConfigSummary } from "@/lib/queries/notifications";
import { EVENT_META } from "./event-meta";
import {
  saveNotificationConfigAction,
  testNotificationAction,
} from "./actions";

export function NotificationsForm({
  configs,
}: {
  configs: NotificationConfigSummary[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {configs.map((config) => (
        <EventConfigCard key={config.eventType} config={config} />
      ))}
    </div>
  );
}

function EventConfigCard({ config }: { config: NotificationConfigSummary }) {
  const meta = EVENT_META[config.eventType];
  const Icon = meta.icon;
  const colors = TILE_COLORS[meta.accent];

  const router = useRouter();
  const [enabled, setEnabled] = useState(config.enabled);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  // Track whether the operator has started typing — an empty field when
  // the server already has a token stored means "don't touch"; a typed
  // empty field means "clear it".
  const [tokenDirty, setTokenDirty] = useState(false);
  const [chatIdDirty, setChatIdDirty] = useState(false);
  const [saving, startSaving] = useTransition();
  const [testing, startTesting] = useTransition();

  const pristine =
    enabled === config.enabled && !tokenDirty && !chatIdDirty;

  function handleSave() {
    startSaving(async () => {
      try {
        // Only send fields the operator actually changed. `undefined`
        // leaves server-side values alone; `null` explicitly clears.
        const tokenValue =
          tokenDirty ? (botToken.trim() ? botToken.trim() : null) : undefined;
        const chatIdValue =
          chatIdDirty ? (chatId.trim() ? chatId.trim() : null) : undefined;

        await saveNotificationConfigAction({
          eventType: config.eventType,
          enabled,
          botToken: tokenValue,
          chatId: chatIdValue,
        });
        toast.success(`${meta.label} notifications saved`);
        // Reset dirty flags + clear the secret inputs; the UI will
        // re-render with the new "Configured" badge state from the
        // refreshed server component.
        setBotToken("");
        setChatId("");
        setTokenDirty(false);
        setChatIdDirty(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save");
      }
    });
  }

  function handleTest() {
    startTesting(async () => {
      const result = await testNotificationAction(config.eventType);
      if (result.ok) {
        toast.success(`Test message sent for ${meta.label.toLowerCase()}`);
      } else {
        toast.error(result.error ?? "Failed to send test message");
      }
    });
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-12 -top-12 size-32 rounded-full blur-2xl opacity-40",
          colors.bg,
        )}
      />
      <div className="relative p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex size-10 items-center justify-center rounded-xl",
                colors.bg,
              )}
            >
              <Icon className={cn("size-5", colors.icon)} />
            </div>
            <div>
              <h3 className="text-base font-semibold">{meta.label}</h3>
              <p className="text-xs text-muted-foreground">{meta.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Label
              htmlFor={`enable-${config.eventType}`}
              className="text-xs font-medium text-muted-foreground"
            >
              {enabled ? "Enabled" : "Disabled"}
            </Label>
            <Switch
              id={`enable-${config.eventType}`}
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor={`bot-${config.eventType}`}>Bot token</Label>
              <ConfiguredChip has={config.hasToken} />
            </div>
            <Input
              id={`bot-${config.eventType}`}
              type="password"
              autoComplete="off"
              value={botToken}
              onChange={(e) => {
                setBotToken(e.target.value);
                if (!tokenDirty) setTokenDirty(true);
              }}
              placeholder={
                config.hasToken
                  ? "Leave blank to keep saved token"
                  : "123456:ABC-DEF..."
              }
            />
            <p className="text-[11px] text-muted-foreground">
              Create a bot via @BotFather and paste the token here. Saved
              tokens are never shown again — leave this field blank to keep
              the existing value.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor={`chat-${config.eventType}`}>Chat ID</Label>
              <ConfiguredChip has={config.hasChatId} />
            </div>
            <Input
              id={`chat-${config.eventType}`}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={chatId}
              onChange={(e) => {
                setChatId(e.target.value);
                if (!chatIdDirty) setChatIdDirty(true);
              }}
              placeholder={
                config.hasChatId
                  ? "Leave blank to keep saved chat id"
                  : "e.g. 123456789 or -1001234567890"
              }
            />
            <p className="text-[11px] text-muted-foreground">
              Your Telegram user id or a group chat id (negative for groups
              and channels). Leave blank to keep the existing value.
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testing || !config.hasToken || !config.hasChatId}
          >
            <Send className="mr-1.5 size-3.5" />
            {testing ? "Sending..." : "Send test"}
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || pristine}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>

        {!enabled && !config.hasToken && !config.hasChatId && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Disabled &mdash; add credentials and toggle on to start forwarding.
          </p>
        )}
      </div>
    </div>
  );
}

function ConfiguredChip({ has }: { has: boolean }) {
  return has ? (
    <Badge
      variant="outline"
      className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
    >
      Configured
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="bg-muted text-muted-foreground border-border"
    >
      Not set
    </Badge>
  );
}

// Helpers moved to ./event-meta — shared between server + client so the
// Server Component page isn't calling a function through a client
// reference.
