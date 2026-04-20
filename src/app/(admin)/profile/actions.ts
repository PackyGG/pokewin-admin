"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { verifySession } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";

// ---- Constants ----------------------------------------------------------

const MAX_AVATAR_BYTES = 500 * 1024; // 500 KB
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
type AllowedMime = (typeof ALLOWED_MIME)[number];

// Magic-byte prefixes for the allowed formats. We verify the declared MIME
// against the actual bytes so a malicious client can't upload e.g. an HTML
// file labeled as image/png.
const MAGIC_BYTES: Record<AllowedMime, number[][]> = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/webp": [
    // "RIFF" .... "WEBP"
    [0x52, 0x49, 0x46, 0x46],
  ],
};

function bytesStartWith(buf: Uint8Array, prefix: number[]): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[i] !== prefix[i]) return false;
  }
  return true;
}

function verifyMagicBytes(buf: Uint8Array, mime: AllowedMime): boolean {
  const prefixes = MAGIC_BYTES[mime];
  const startOk = prefixes.some((p) => bytesStartWith(buf, p));
  if (!startOk) return false;
  // WebP: also verify "WEBP" at offset 8.
  if (mime === "image/webp") {
    if (buf.length < 12) return false;
    const webp = [0x57, 0x45, 0x42, 0x50];
    for (let i = 0; i < 4; i++) {
      if (buf[8 + i] !== webp[i]) return false;
    }
  }
  return true;
}

// ---- Validation schemas -------------------------------------------------

// display_username: 2-32 chars, no leading/trailing whitespace, no control
// characters. Allows spaces in the middle (so "John Doe" works).
const displayUsernameSchema = z
  .string()
  .min(2, "Display name must be at least 2 characters")
  .max(32, "Display name must be at most 32 characters")
  .refine((v) => v === v.trim(), "No leading or trailing whitespace")
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\x00-\x1f\x7f]/.test(v), "Invalid characters");

const updateProfileSchema = z
  .object({
    displayUsername: displayUsernameSchema.optional(),
    removeAvatar: z.boolean().optional(),
  })
  .refine(
    (v) => v.displayUsername !== undefined || v.removeAvatar === true,
    "Nothing to update",
  );

// ---- Graceful pre-migration handling ------------------------------------

// Prisma errors for missing columns come through as P2022 ("The column ...
// does not exist in the current database"). If the user has generated the
// client but not yet run `npm run admin:migrate`, we want a clear message
// instead of a 500.
function isMissingColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === "P2022") return true;
  return /column .* does not exist/i.test(err.message);
}

const PRE_MIGRATION_MESSAGE =
  "Profile fields are not enabled yet — please run the database migration (npm run admin:migrate).";

// ---- Actions ------------------------------------------------------------

export async function updateProfile(input: {
  displayUsername?: string;
  removeAvatar?: boolean;
}) {
  const session = await verifySession();

  const parsed = updateProfileSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  const data: {
    display_username?: string;
    profile_image?: Uint8Array<ArrayBuffer> | null;
    profile_image_mime?: string | null;
  } = {};

  if (parsed.data.displayUsername !== undefined) {
    data.display_username = parsed.data.displayUsername.trim();
  }
  if (parsed.data.removeAvatar) {
    data.profile_image = null;
    data.profile_image_mime = null;
  }

  try {
    await adminDb.admin_users.update({
      where: { id: session.userId },
      data,
      select: { id: true },
    });
  } catch (err) {
    if (isMissingColumnError(err)) throw new Error(PRE_MIGRATION_MESSAGE);
    throw err;
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_profile_updated",
    metadata: {
      displayUsernameUpdated: parsed.data.displayUsername !== undefined,
      avatarRemoved: parsed.data.removeAvatar === true,
    },
  });

  revalidatePath("/profile");
  // The avatar in the header is driven by the layout, which reads the
  // current admin's row — revalidate the root so the header reloads.
  revalidatePath("/", "layout");
}

export async function uploadAvatar(formData: FormData) {
  const session = await verifySession();

  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("No file provided");
  }

  // Server-side MIME whitelist (declared MIME only — magic bytes checked below).
  const declaredMime = file.type;
  if (!ALLOWED_MIME.includes(declaredMime as AllowedMime)) {
    throw new Error("Only PNG, JPEG or WEBP images are allowed");
  }
  const mime = declaredMime as AllowedMime;

  // Server-side size limit (client may be bypassed).
  if (file.size === 0) throw new Error("Empty file");
  if (file.size > MAX_AVATAR_BYTES) {
    throw new Error("File too large (max 500 KB)");
  }

  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new Error("File too large (max 500 KB)");
  }

  // Magic-byte check: reject files whose actual content doesn't match the
  // declared MIME type. Prevents "upload HTML as PNG" style attacks.
  if (!verifyMagicBytes(bytes, mime)) {
    throw new Error("File content does not match declared image type");
  }

  try {
    // Prisma 7 expects Uint8Array<ArrayBuffer> for Bytes columns. Copy into
    // a fresh ArrayBuffer-backed Uint8Array so the type lines up.
    const storedBytes = new Uint8Array(new ArrayBuffer(bytes.length));
    storedBytes.set(bytes);
    await adminDb.admin_users.update({
      where: { id: session.userId },
      data: {
        profile_image: storedBytes,
        profile_image_mime: mime,
      },
      select: { id: true },
    });
  } catch (err) {
    if (isMissingColumnError(err)) throw new Error(PRE_MIGRATION_MESSAGE);
    throw err;
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_profile_updated",
    metadata: { avatarUploaded: true, size: bytes.length, mime },
  });

  revalidatePath("/profile");
  revalidatePath("/", "layout");
}
