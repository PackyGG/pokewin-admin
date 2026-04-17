"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Upload, Trash2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ROLE_COLORS } from "@/lib/constants";
import { updateProfile, uploadAvatar } from "./actions";

const MAX_AVATAR_BYTES = 500 * 1024;
const MAX_DIMENSION = 2048;
const TARGET_DIMENSION = 512; // what we resize down to (covers common avatar sizes)
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

// Cache-buster so the Avatar reloads after an upload/remove round-trip.
function cacheKey() {
  return Date.now().toString(36);
}

function initials(source: string): string {
  const clean = source.trim();
  if (!clean) return "?";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

/**
 * Resize/compress an image client-side via <canvas>. Returns a Blob matching
 * one of the ALLOWED_MIME types, under MAX_AVATAR_BYTES when possible.
 *
 * Rejects images larger than MAX_DIMENSION on any side (before resize) as a
 * cheap DoS guard — the server also enforces size limits, but this keeps
 * huge source files from even hitting the wire.
 */
async function prepareImage(file: File): Promise<{ blob: Blob; mime: string }> {
  if (!ALLOWED_MIME.includes(file.type)) {
    throw new Error("Only PNG, JPEG or WEBP images are allowed");
  }

  // Load as HTMLImageElement to read natural dimensions.
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Invalid image file"));
    i.src = dataUrl;
  });

  if (img.naturalWidth > MAX_DIMENSION || img.naturalHeight > MAX_DIMENSION) {
    throw new Error(`Image dimensions must be ${MAX_DIMENSION}px or less on each side`);
  }

  // Scale so the longer side is TARGET_DIMENSION (or less if already small).
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = longest > TARGET_DIMENSION ? TARGET_DIMENSION / longest : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unsupported in this browser");
  ctx.drawImage(img, 0, 0, w, h);

  // Keep PNG as PNG (preserves transparency). JPEG/WEBP go through JPEG with
  // descending quality until under the size cap.
  if (file.type === "image/png") {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
    if (!blob) throw new Error("Could not encode image");
    if (blob.size > MAX_AVATAR_BYTES) {
      // Fall through to JPEG re-encode if PNG is too big (large/noisy images).
      return encodeJpeg(canvas);
    }
    return { blob, mime: "image/png" };
  }

  return encodeJpeg(canvas);
}

async function encodeJpeg(canvas: HTMLCanvasElement): Promise<{ blob: Blob; mime: string }> {
  const qualities = [0.9, 0.8, 0.7, 0.6, 0.5];
  for (const q of qualities) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", q),
    );
    if (!blob) continue;
    if (blob.size <= MAX_AVATAR_BYTES) return { blob, mime: "image/jpeg" };
  }
  throw new Error("Image is too large to compress under 500 KB");
}

export function ProfileForm({
  adminId,
  username,
  email,
  role,
  displayUsername,
  hasAvatar,
  profileFieldsAvailable,
}: {
  adminId: string;
  username: string;
  email: string;
  role: string;
  displayUsername: string | null;
  hasAvatar: boolean;
  profileFieldsAvailable: boolean;
}) {
  const [displayName, setDisplayName] = useState(displayUsername ?? "");
  const [savingName, setSavingName] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [avatarCacheKey, setAvatarCacheKey] = useState(() => cacheKey());
  const [hasAvatarLocal, setHasAvatarLocal] = useState(hasAvatar);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const avatarSrc = hasAvatarLocal
    ? `/api/admin/avatar/${adminId}?v=${avatarCacheKey}`
    : undefined;

  const fallbackLabel = initials(displayName || username);

  async function handleNameSave(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = displayName.trim();
    if (trimmed.length < 2 || trimmed.length > 32) {
      toast.error("Display name must be between 2 and 32 characters");
      return;
    }
    setSavingName(true);
    try {
      await updateProfile({ displayUsername: trimmed });
      toast.success("Display name updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update profile");
    } finally {
      setSavingName(false);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-uploading the same file
    if (!file) return;

    // Preliminary client checks — server also enforces.
    if (!ALLOWED_MIME.includes(file.type)) {
      toast.error("Only PNG, JPEG or WEBP images are allowed");
      return;
    }
    // Guard: even before compression, refuse multi-MB files outright — they
    // almost certainly exceed MAX_DIMENSION and waste a round-trip.
    if (file.size > 10 * 1024 * 1024) {
      toast.error("File too large (max 10 MB source)");
      return;
    }

    setUploading(true);
    try {
      const { blob, mime } = await prepareImage(file);
      if (blob.size > MAX_AVATAR_BYTES) {
        throw new Error("Image is too large after compression");
      }

      const form = new FormData();
      form.append(
        "file",
        new File([blob], `avatar.${mime === "image/png" ? "png" : "jpg"}`, { type: mime }),
      );
      await uploadAvatar(form);

      setHasAvatarLocal(true);
      setAvatarCacheKey(cacheKey());
      toast.success("Profile picture updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      await updateProfile({ removeAvatar: true });
      setHasAvatarLocal(false);
      setAvatarCacheKey(cacheKey());
      toast.success("Profile picture removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove avatar");
    } finally {
      setRemoving(false);
    }
  }

  const disabledDueToMigration = !profileFieldsAvailable;

  return (
    <div className="space-y-6">
      {/* Identity header */}
      <div className="flex items-center gap-4">
        <Avatar size="lg">
          {avatarSrc && <AvatarImage src={avatarSrc} alt={fallbackLabel} />}
          <AvatarFallback>{fallbackLabel}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-medium">
              {displayUsername ?? username}
            </span>
            <Badge variant="outline" className={ROLE_COLORS[role] ?? ""}>
              {role}
            </Badge>
          </div>
          <div className="truncate text-xs text-muted-foreground">{email}</div>
          <div className="truncate text-xs text-muted-foreground">@{username}</div>
        </div>
      </div>

      {/* Avatar controls */}
      <div className="space-y-2">
        <Label>Profile picture</Label>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading || removing || disabledDueToMigration}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mr-2 size-4" />
            {uploading ? "Uploading..." : "Upload image"}
          </Button>
          {hasAvatarLocal && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={uploading || removing || disabledDueToMigration}
              onClick={handleRemove}
            >
              <Trash2 className="mr-2 size-4" />
              {removing ? "Removing..." : "Remove"}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          PNG, JPEG or WEBP, up to 500 KB. Images are resized automatically.
          {disabledDueToMigration && " Run the migration to enable profile pictures."}
        </p>
      </div>

      {/* Display name form */}
      <form className="space-y-2" onSubmit={handleNameSave}>
        <Label htmlFor="display-username">Display name</Label>
        <Input
          id="display-username"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={username}
          minLength={2}
          maxLength={32}
          disabled={disabledDueToMigration}
        />
        <p className="text-xs text-muted-foreground">
          Shown across the admin panel. Falls back to @{username} if empty.
        </p>
        <Button
          type="submit"
          size="sm"
          disabled={savingName || disabledDueToMigration || displayName.trim() === (displayUsername ?? "")}
        >
          {savingName ? "Saving..." : "Save display name"}
        </Button>
      </form>
    </div>
  );
}
