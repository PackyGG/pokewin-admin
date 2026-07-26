"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, Send, Users } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { StaffNotificationRecipient } from "@/lib/staff/notifications";
import { sendStaffNotificationAction } from "./actions";

type Audience = "selected" | "role" | "all";

export function StaffNotificationComposer({
  recipients,
}: {
  recipients: StaffNotificationRecipient[];
}) {
  const router = useRouter();
  const [audience, setAudience] = React.useState<Audience>("selected");
  const [selected, setSelected] = React.useState<string[]>([]);
  const [role, setRole] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [href, setHref] = React.useState("");
  const [externalChannels, setExternalChannels] = React.useState(true);
  const [pending, startTransition] = React.useTransition();

  const roles = React.useMemo(
    () =>
      [...new Set(recipients.flatMap((recipient) => recipient.roles))].sort(),
    [recipients],
  );
  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return recipients;
    return recipients.filter((recipient) =>
      [
        recipient.username,
        recipient.displayName,
        recipient.email,
        ...recipient.roles,
      ].some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [query, recipients]);

  const audienceCount =
    audience === "all"
      ? recipients.length
      : audience === "role"
        ? recipients.filter((recipient) => recipient.roles.includes(role)).length
        : selected.length;

  function toggleRecipient(id: string, checked: boolean) {
    setSelected((current) =>
      checked
        ? [...new Set([...current, id])]
        : current.filter((value) => value !== id),
    );
  }

  function send() {
    startTransition(async () => {
      try {
        const result = await sendStaffNotificationAction({
          audience,
          recipientIds: selected,
          role: role || undefined,
          title,
          body,
          href,
          externalChannels,
        });
        toast.success(
          `Sent to ${result.targeted} staff account${result.targeted === 1 ? "" : "s"}; ${result.inboxRows} inbox row${result.inboxRows === 1 ? "" : "s"} created.`,
        );
        setTitle("");
        setBody("");
        setHref("");
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not send notification",
        );
      }
    });
  }

  const blocked =
    pending ||
    title.trim().length < 3 ||
    audienceCount === 0 ||
    (audience === "role" && !role);

  return (
    <div className="grid gap-5 rounded-xl border border-border/60 bg-card p-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.72fr)]">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Audience</Label>
          <div className="grid grid-cols-3 gap-2">
            {(["selected", "role", "all"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={audience === value ? "default" : "outline"}
                onClick={() => setAudience(value)}
                disabled={pending}
                className="capitalize"
              >
                {value === "all" ? "All active" : value}
              </Button>
            ))}
          </div>
        </div>

        {audience === "role" && (
          <div className="space-y-1.5">
            <Label htmlFor="staff-notification-role">System role</Label>
            <select
              id="staff-notification-role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              disabled={pending}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="">Pick a role</option>
              {roles.map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </div>
        )}

        {audience === "selected" && (
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search staff by name, email or role"
                className="pl-9"
                disabled={pending}
              />
            </div>
            <div className="max-h-52 overflow-y-auto rounded-md border border-border/60">
              {filtered.map((recipient) => {
                const label = recipient.displayName ?? recipient.username;
                const checked = selected.includes(recipient.id);
                return (
                  <label
                    key={recipient.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 border-b border-border/50 px-3 py-2.5 last:border-0 hover:bg-accent/50",
                      checked && "bg-cyan-500/[0.05]",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(value) =>
                        toggleRecipient(recipient.id, value === true)
                      }
                      disabled={pending}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {label}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        @{recipient.username} · {recipient.email}
                      </span>
                    </span>
                    <Badge variant="outline" className="shrink-0 text-[9px]">
                      {recipient.roles[0]?.replaceAll("_", " ")}
                    </Badge>
                  </label>
                );
              })}
              {filtered.length === 0 && (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No active staff match this search.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="staff-notification-title">Title</Label>
          <Input
            id="staff-notification-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={100}
            placeholder="What does the team need to know?"
            disabled={pending}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="staff-notification-body">Message</Label>
          <Textarea
            id="staff-notification-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={1_000}
            rows={4}
            placeholder="Add context, instructions, or a deadline."
            disabled={pending}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="staff-notification-href">Dashboard link (optional)</Label>
          <Input
            id="staff-notification-href"
            value={href}
            onChange={(event) => setHref(event.target.value)}
            maxLength={500}
            placeholder="/users or /antifraud/reviews/..."
            disabled={pending}
          />
          <p className="text-[11px] text-muted-foreground">
            Use a canonical internal path. Cross-app links are resolved for the
            dashboard host the recipient is currently using.
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2.5">
          <span>
            <span className="block text-sm font-medium">External channels</span>
            <span className="block text-[11px] text-muted-foreground">
              Also use verified Discord or Telegram when the recipient opted in.
            </span>
          </span>
          <Switch
            checked={externalChannels}
            onCheckedChange={setExternalChannels}
            disabled={pending}
          />
        </div>

        <Button onClick={send} disabled={blocked} className="gap-2">
          <Send className="size-4" />
          {pending ? "Sending…" : `Send to ${audienceCount || 0}`}
        </Button>
      </div>

      <aside className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Users className="size-4 text-cyan-500" />
          Delivery preview
        </div>
        <div className="rounded-xl border border-border/60 bg-background/70 p-4">
          <div className="flex items-start gap-2">
            <span className="mt-1.5 size-2 shrink-0 rounded-full bg-cyan-500" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold">
                {title.trim() || "Notification title"}
              </span>
              <span className="mt-1 block whitespace-pre-wrap text-xs text-muted-foreground">
                {body.trim() || "Your message will appear here."}
              </span>
              {href.trim() && (
                <span className="mt-2 block truncate font-mono text-[10px] text-cyan-600 dark:text-cyan-400">
                  {href.trim()}
                </span>
              )}
            </span>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The send targets {audienceCount} active staff account
          {audienceCount === 1 ? "" : "s"}. In-app rows and external pings
          respect each recipient&apos;s announcement preferences.
        </p>
      </aside>
    </div>
  );
}
