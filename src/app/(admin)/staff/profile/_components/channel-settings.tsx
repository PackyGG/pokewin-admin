"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { BellRing, Check, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  removeNotificationChannel,
  saveNotificationChannel,
  sendTestPing,
  toggleNotificationChannel,
  verifyNotificationChannel,
} from "../actions";

/**
 * Discord / Telegram channel setup.
 *
 * Discord is the default channel and comes first; Telegram is the opt-in
 * alternative. Both follow the same three-step flow, and step 2 is the one that
 * matters:
 *
 *   1. enter your id  →  2. we ping it with a 6-digit code  →  3. type it back
 *
 * Until step 3 the channel is INERT (the server only ever delivers to a row
 * with `verified_at` set), so a typo can't quietly ping a stranger for months.
 */

export type ChannelState = {
  channel: "discord" | "telegram";
  target: string | null;
  enabled: boolean;
  verified: boolean;
  lastError: string | null;
  lastSentAt: string | null;
  /** Whether this deployment has the credentials to deliver at all. */
  configured: boolean;
};

const COPY: Record<
  ChannelState["channel"],
  { name: string; hint: string; placeholder: string; badge: string }
> = {
  discord: {
    name: "Discord",
    badge: "Default",
    hint: "Turn on Developer Mode in Discord, right-click your name and choose Copy User ID. Alerts arrive as a mention in the staff channel.",
    placeholder: "e.g. 372615489256816642",
  },
  telegram: {
    name: "Telegram",
    badge: "Optional",
    hint: "Open a chat with the Packy bot and press Start, then paste the numeric chat id it replies with.",
    placeholder: "e.g. 872615489",
  },
};

export function ChannelSettings({ channels }: { channels: ChannelState[] }) {
  return (
    <div className="space-y-3">
      {channels.map((channel) => (
        <ChannelCard key={channel.channel} state={channel} />
      ))}
    </div>
  );
}

function ChannelCard({ state }: { state: ChannelState }) {
  const router = useRouter();
  const copy = COPY[state.channel];
  const [target, setTarget] = React.useState(state.target ?? "");
  const [code, setCode] = React.useState("");
  const [pending, setPending] = React.useState<string | null>(null);
  const [awaitingCode, setAwaitingCode] = React.useState(
    Boolean(state.target) && !state.verified,
  );

  async function run(key: string, fn: () => Promise<void>) {
    setPending(key);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPending(null);
    }
  }

  return (
    <div
      className={cn(
        "space-y-3 rounded-xl border bg-card p-4",
        state.verified && state.enabled
          ? "border-emerald-500/30"
          : "border-border/60",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-lg",
              state.verified
                ? "bg-emerald-500/10 text-emerald-500"
                : "bg-muted text-muted-foreground",
            )}
          >
            <BellRing className="size-3.5" />
          </span>
          <span className="truncate text-sm font-semibold">{copy.name}</span>
          <span className="shrink-0 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {copy.badge}
          </span>
          {state.verified && (
            <span className="flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
              <Check className="size-3" />
              Verified
            </span>
          )}
        </div>

        {state.verified && (
          <Switch
            checked={state.enabled}
            disabled={pending !== null}
            onCheckedChange={(checked) =>
              run("toggle", () =>
                toggleNotificationChannel({
                  channel: state.channel,
                  enabled: checked === true,
                }),
              )
            }
            aria-label={`${copy.name} notifications`}
          />
        )}
      </div>

      {!state.configured && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
          {copy.name} isn&apos;t configured on this deployment yet, so nothing can
          be delivered here. In-app notifications still work.
        </p>
      )}

      <p className="text-[11px] text-muted-foreground">{copy.hint}</p>

      {/* ── Step 1: the id ────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <Label htmlFor={`${state.channel}-target`}>
          {state.channel === "discord" ? "Discord user id" : "Telegram chat id"}
        </Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={`${state.channel}-target`}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={copy.placeholder}
            inputMode="numeric"
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending !== null || !state.configured || !target.trim()}
            onClick={() =>
              run("save", async () => {
                const result = await saveNotificationChannel({
                  channel: state.channel,
                  target: target.trim(),
                });
                if (result.sent) {
                  setAwaitingCode(true);
                  toast.success(result.message);
                } else {
                  toast.error(result.message);
                }
              })
            }
          >
            {pending === "save"
              ? "Sending…"
              : state.verified
                ? "Change & re-verify"
                : "Send code"}
          </Button>
        </div>
      </div>

      {/* ── Step 2: the code ──────────────────────────────────────── */}
      {awaitingCode && !state.verified && (
        <div className="space-y-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3">
          <Label htmlFor={`${state.channel}-code`}>
            Enter the 6-digit code we just sent
          </Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={`${state.channel}-code`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="000000"
              inputMode="numeric"
              maxLength={6}
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              size="sm"
              disabled={pending !== null || code.trim().length !== 6}
              onClick={() =>
                run("verify", async () => {
                  await verifyNotificationChannel({
                    channel: state.channel,
                    code: code.trim(),
                  });
                  setCode("");
                  setAwaitingCode(false);
                  toast.success(`${copy.name} verified — pings are on`);
                })
              }
            >
              {pending === "verify" ? "Checking…" : "Verify"}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            The code expires after 30 minutes. Five wrong tries burns it — send
            a new one.
          </p>
        </div>
      )}

      {state.lastError && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-600 dark:text-rose-400">
          Last delivery failed: {state.lastError}
        </p>
      )}

      {state.target && (
        <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
          {state.verified && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={() =>
                run("test", async () => {
                  await sendTestPing({ channel: state.channel });
                  toast.success("Test ping sent");
                })
              }
            >
              <Send className="mr-2 size-4" />
              {pending === "test" ? "Sending…" : "Send test ping"}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending !== null}
            onClick={() =>
              run("remove", async () => {
                await removeNotificationChannel({ channel: state.channel });
                setTarget("");
                setAwaitingCode(false);
                toast.success(`${copy.name} removed`);
              })
            }
          >
            <Trash2 className="mr-2 size-4" />
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}
