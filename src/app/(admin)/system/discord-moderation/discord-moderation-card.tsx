"use client";

import { useState, useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ux";
import type { DiscordModerationSettings } from "@/lib/discord-moderation-settings";

import { updateDiscordModerationSettingsAction } from "./actions";

function lines(values: readonly string[]): string {
  return values.join("\n");
}

function splitLines(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

export function DiscordModerationCard({
  initial,
}: {
  initial: DiscordModerationSettings;
}) {
  const [isPending, startTransition] = useTransition();
  const [settings, setSettings] = useState(initial);
  const [blockedWords, setBlockedWords] = useState(lines(initial.blockedWords));
  const [allowedInvites, setAllowedInvites] = useState(lines(initial.allowedInviteCodes));
  const [exemptRoles, setExemptRoles] = useState(lines(initial.exemptRoleIds));
  const [exemptChannels, setExemptChannels] = useState(lines(initial.exemptChannelIds));

  const update = (patch: Partial<DiscordModerationSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  };

  const save = () => {
    const input: DiscordModerationSettings = {
      ...settings,
      blockedWords: splitLines(blockedWords),
      allowedInviteCodes: splitLines(allowedInvites),
      exemptRoleIds: splitLines(exemptRoles),
      exemptChannelIds: splitLines(exemptChannels),
    };
    startTransition(async () => {
      const result = await updateDiscordModerationSettingsAction(input);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setSettings(result.settings);
      setBlockedWords(lines(result.settings.blockedWords));
      setAllowedInvites(lines(result.settings.allowedInviteCodes));
      setExemptRoles(lines(result.settings.exemptRoleIds));
      setExemptChannels(lines(result.settings.exemptChannelIds));
      toast.success("Discord moderation settings saved");
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" />
          <CardTitle>PackyGG message filtering</CardTitle>
        </div>
        <CardDescription>
          Applies only to server {settings.guildId}. Matching messages and edited messages are deleted;
          the existing deleted-message log keeps the staff audit copy.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 md:grid-cols-2">
          <ToggleRow id="moderation-enabled" label="Moderation enabled" description="Master switch for every rule on this page." checked={settings.enabled} disabled={isPending} onCheckedChange={(enabled) => update({ enabled })} />
          <ToggleRow id="moderator-exemption" label="Exempt moderators" description="Members with Manage Messages or Manage Server bypass filters." checked={settings.exemptModerators} disabled={isPending} onCheckedChange={(exemptModerators) => update({ exemptModerators })} />
          <ToggleRow id="word-filter" label="Word filter" description="Case-insensitive whole words and phrases, including edited messages." checked={settings.wordFilterEnabled} disabled={isPending} onCheckedChange={(wordFilterEnabled) => update({ wordFilterEnabled })} />
          <ToggleRow id="invite-filter" label="Discord invite filter" description="Blocks standard and lightly obfuscated Discord invite links." checked={settings.inviteFilterEnabled} disabled={isPending} onCheckedChange={(inviteFilterEnabled) => update({ inviteFilterEnabled })} />
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="blocked-words">Blocked words or phrases</Label>
            <Textarea id="blocked-words" rows={10} value={blockedWords} disabled={isPending} onChange={(event) => setBlockedWords(event.target.value)} placeholder={"one entry per line\nblocked phrase"} />
            <p className="text-xs text-muted-foreground">One per line. A plain word will not match inside a larger word.</p>
          </div>
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="allowed-invites">Allowed Discord invite codes</Label>
              <Textarea id="allowed-invites" rows={4} value={allowedInvites} disabled={isPending} onChange={(event) => setAllowedInvites(event.target.value)} placeholder="packy" />
              <p className="text-xs text-muted-foreground">Enter only the final code from discord.gg/code.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="exempt-roles">Exempt role IDs</Label>
              <Textarea id="exempt-roles" rows={3} value={exemptRoles} disabled={isPending} onChange={(event) => setExemptRoles(event.target.value)} placeholder="123456789012345678" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="exempt-channels">Exempt channel IDs</Label>
              <Textarea id="exempt-channels" rows={3} value={exemptChannels} disabled={isPending} onChange={(event) => setExemptChannels(event.target.value)} placeholder="123456789012345678" />
            </div>
          </div>
        </div>

        <Button onClick={save} disabled={isPending}>
          {isPending && <Spinner size={15} className="text-current" />}
          {isPending ? "Saving..." : "Save moderation settings"}
        </Button>
      </CardContent>
    </Card>
  );
}
