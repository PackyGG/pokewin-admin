"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Camera, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { TILE_COLORS, type AccentColor } from "@/components/modern-panels";
import { updateProfile, uploadAvatar } from "@/app/(admin)/profile/actions";
import { updateStaffProfile } from "../actions";

/**
 * "Your profile" editor.
 *
 * The AVATAR is written through the EXISTING dashboard profile actions
 * (`uploadAvatar` / `updateProfile`), which already own `admin_users
 * .profile_image` and are used by the header's profile dialog. Reusing them
 * means one picture everywhere — sidebar, header, staff board — instead of a
 * second copy that can drift, and it inherits their MIME whitelist, 500 KB cap
 * and magic-byte check for free.
 *
 * Everything else (display name, job title, bio, accent) is the staff-profile
 * row, written by `updateStaffProfile`.
 */

const ACCENTS: AccentColor[] = [
  "blue",
  "cyan",
  "emerald",
  "amber",
  "orange",
  "rose",
  "pink",
  "purple",
];

export function ProfileEditor({
  adminUserId,
  username,
  hasAvatar,
  initial,
}: {
  adminUserId: string;
  username: string;
  hasAvatar: boolean;
  initial: {
    displayName: string;
    title: string;
    bio: string;
    accent: string;
  };
}) {
  const router = useRouter();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [saving, setSaving] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [values, setValues] = React.useState(initial);
  // Cache-busts the avatar <img> after an upload — the endpoint sets a short
  // cache header, so without this the old picture lingers for a minute.
  const [avatarVersion, setAvatarVersion] = React.useState(0);
  const [avatarPresent, setAvatarPresent] = React.useState(hasAvatar);

  function set<K extends keyof typeof values>(
    key: K,
    value: (typeof values)[K],
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await updateStaffProfile({
        displayName: values.displayName.trim(),
        title: values.title.trim(),
        bio: values.bio.trim(),
        accent: values.accent,
      });
      toast.success("Profile saved");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      await uploadAvatar(formData);
      setAvatarPresent(true);
      setAvatarVersion((v) => v + 1);
      toast.success("Picture updated");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not upload");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleRemoveAvatar() {
    setUploading(true);
    try {
      await updateProfile({ removeAvatar: true });
      setAvatarPresent(false);
      setAvatarVersion((v) => v + 1);
      toast.success("Picture removed");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove");
    } finally {
      setUploading(false);
    }
  }

  const label = values.displayName.trim() || username;

  return (
    <form
      onSubmit={handleSave}
      className="space-y-5 rounded-xl border border-border/60 bg-card p-4"
    >
      {/* ── Picture ────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-4">
        <Avatar size="lg" className="size-16 shrink-0">
          {avatarPresent && (
            <AvatarImage
              src={`/api/admin/avatar/${adminUserId}?v=${avatarVersion}`}
              alt={label}
            />
          )}
          <AvatarFallback className="text-lg font-semibold">
            {label.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={handleFile}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <Camera className="mr-2 size-4" />
            {uploading ? "Working…" : "Change picture"}
          </Button>
          {avatarPresent && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={uploading}
              onClick={handleRemoveAvatar}
            >
              <Trash2 className="mr-2 size-4" />
              Remove
            </Button>
          )}
          <p className="w-full text-[11px] text-muted-foreground">
            PNG, JPEG or WEBP, up to 500 KB. This is the same picture the rest
            of the dashboard shows.
          </p>
        </div>
      </div>

      {/* ── Fields ─────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="staff-name">Display name</Label>
          <Input
            id="staff-name"
            value={values.displayName}
            onChange={(e) => set("displayName", e.target.value)}
            placeholder={username}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="staff-title">Job title</Label>
          <Input
            id="staff-title"
            value={values.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="e.g. Fraud Analyst"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="staff-bio">About you</Label>
        <Textarea
          id="staff-bio"
          value={values.bio}
          onChange={(e) => set("bio", e.target.value)}
          rows={3}
          placeholder="Shown to the rest of the team on your profile."
        />
      </div>

      <div className="space-y-1.5">
        <Label>Accent colour</Label>
        <div className="flex flex-wrap gap-2">
          {ACCENTS.map((accent) => {
            const tile = TILE_COLORS[accent];
            const active = values.accent === accent;
            return (
              <button
                key={accent}
                type="button"
                onClick={() => set("accent", accent)}
                aria-label={accent}
                aria-pressed={active}
                className={cn(
                  "size-8 rounded-lg border transition-transform",
                  tile.bg,
                  active
                    ? "ring-2 ring-foreground/60 ring-offset-2 ring-offset-background"
                    : "hover:scale-105",
                )}
              />
            );
          })}
        </div>
      </div>

      <Button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save profile"}
      </Button>
    </form>
  );
}
