"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { setAntifraudAccessList, setAntifraudRoleAccess } from "../actions";

/**
 * Who can enter the workspace.
 *
 * Role toggles are the bulk control; the username lists are the override on
 * top. Owners and admins are always in and cannot be denied — the copy says so
 * rather than pretending the deny list is absolute, because the server enforces
 * exactly that.
 */

export function RoleAccessToggles({
  roles,
}: {
  roles: { role: string; label: string; enabled: boolean }[];
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);

  return (
    <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
      {roles.map((entry) => (
        <div
          key={entry.role}
          className="flex items-center justify-between gap-3 px-4 py-3"
        >
          <div className="min-w-0">
            <span className="block text-sm font-medium">{entry.label}</span>
            <span className="block text-[11px] text-muted-foreground">
              Everyone holding the {entry.label.toLowerCase()} role gets the
              workspace and the sidebar card.
            </span>
          </div>
          <Switch
            checked={entry.enabled}
            disabled={pending !== null}
            aria-label={`${entry.label} access`}
            onCheckedChange={async (checked) => {
              setPending(entry.role);
              try {
                await setAntifraudRoleAccess({
                  role: entry.role,
                  enabled: checked === true,
                });
                toast.success(
                  checked ? `${entry.label} can enter` : `${entry.label} blocked`,
                );
                router.refresh();
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : "Could not save",
                );
              } finally {
                setPending(null);
              }
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function AccessListEditor({
  list,
  initial,
}: {
  list: "allowlist" | "denylist";
  initial: string[];
}) {
  const router = useRouter();
  const [value, setValue] = React.useState(initial.join("\n"));
  const [saving, setSaving] = React.useState(false);

  const isAllow = list === "allowlist";

  return (
    <form
      className="space-y-2 rounded-xl border border-border/60 bg-card p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
          await setAntifraudAccessList({ list, usernames: value });
          toast.success(isAllow ? "Allow list saved" : "Deny list saved");
          router.refresh();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not save");
        } finally {
          setSaving(false);
        }
      }}
    >
      <Label htmlFor={`access-${list}`}>
        {isAllow ? "Always allowed" : "Always denied"}
      </Label>
      <p className="text-[11px] text-muted-foreground">
        {isAllow
          ? "Usernames that get in regardless of their role. One per line."
          : "Usernames that are blocked even if their role would let them in. One per line. Owners and admins can never be denied."}
      </p>
      <Textarea
        id={`access-${list}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={4}
        placeholder="username"
        className="font-mono text-xs"
      />
      <Button type="submit" size="sm" variant="outline" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
