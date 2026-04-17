"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import {
  SETTINGS_KEYS,
  getAdminSetting,
  setAdminSetting,
} from "@/lib/admin-settings";
import { createAdminAuditEvent } from "@/lib/admin-audit";

// ---------------------------------------------------------------------------
// House account — the real user that owns every ad code.
// ---------------------------------------------------------------------------

// Main-site user IDs are plain `String` (not UUID) — see model User in
// prisma/schema.prisma. Accept any trimmed non-empty id up to a sane cap.
// Existence is re-checked against the users table below before persisting.
const setHouseAccountSchema = z.object({
  userId: z
    .string()
    .trim()
    .min(1, "User id is required")
    .max(64, "User id is too long"),
});

export async function setHouseAccount(userId: string) {
  const session = await requirePageAccess("/creators/ads");
  await requireCapability(session, "__can_set_house_account", "set the ads house account");

  const parsed = setHouseAccountSchema.safeParse({ userId });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid user id");
  }

  // Verify the user exists before persisting — otherwise callers will
  // see an empty dashboard with no clue why.
  const user = await db.user.findUnique({
    where: { id: parsed.data.userId },
    select: { id: true, username: true, email: true },
  });
  if (!user) throw new Error("User not found");

  await setAdminSetting(
    SETTINGS_KEYS.HOUSE_AFFILIATE_USER_ID,
    user.id,
    session.userId,
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "ads_house_account_set",
    targetUserId: user.id,
    metadata: { username: user.username, email: user.email },
  });

  revalidatePath("/creators/ads");
}

// ---------------------------------------------------------------------------
// Ad codes — just affiliate_codes rows owned by the house user.
// ---------------------------------------------------------------------------

// Affiliate codes are VarChar(20) with a unique constraint, and they're
// exposed in URLs, so keep the alphabet conservative: alphanumerics,
// dash, underscore, 2-20 chars. Matches the de-facto format used for
// creator codes.
const codeSchema = z
  .string()
  .trim()
  .min(2, "Code must be at least 2 characters")
  .max(20, "Code must be at most 20 characters")
  .regex(/^[a-zA-Z0-9_-]+$/, "Only letters, numbers, - and _ are allowed");

async function getRequiredHouseUserId(): Promise<string> {
  const id = await getAdminSetting(SETTINGS_KEYS.HOUSE_AFFILIATE_USER_ID);
  if (!id) throw new Error("House account is not configured");
  return id;
}

export async function createAdCode(code: string) {
  const session = await requirePageAccess("/creators/ads");
  await requireCapability(session, "__can_create_ad_code", "create ad codes");

  const parsed = codeSchema.safeParse(code);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid code");
  }
  const value = parsed.data;

  const houseUserId = await getRequiredHouseUserId();

  // Verify the house user still exists — prevents orphan codes if the
  // account was deleted after the setting was saved.
  const houseUser = await db.user.findUnique({
    where: { id: houseUserId },
    select: { id: true },
  });
  if (!houseUser) throw new Error("House account no longer exists");

  const existing = await db.affiliate_codes.findUnique({
    where: { code: value },
  });
  if (existing) throw new Error("This code is already taken");

  // Ensure the house user has an affiliate_accounts row so the
  // existing click/usage pipeline can credit them. Same pattern as
  // createAffiliateCode in /users/[id]/actions.ts.
  await db.$transaction([
    db.affiliate_accounts.upsert({
      where: { user_id: houseUserId },
      create: { user_id: houseUserId },
      update: {},
    }),
    db.affiliate_codes.create({
      data: {
        user_id: houseUserId,
        code: value,
      },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "ads_code_created",
    targetUserId: houseUserId,
    metadata: { code: value },
  });

  revalidatePath("/creators/ads");
}

export async function deleteAdCode(code: string) {
  const session = await requirePageAccess("/creators/ads");
  await requireCapability(session, "__can_delete_ad_code", "delete ad codes");

  const parsed = codeSchema.safeParse(code);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid code");
  }
  const value = parsed.data;

  const houseUserId = await getRequiredHouseUserId();

  // Strict ownership check — a rogue actor shouldn't be able to wipe a
  // real creator's code by submitting their code name to this action.
  const existing = await db.affiliate_codes.findFirst({
    where: { code: value, user_id: houseUserId },
    select: { id: true },
  });
  if (!existing) throw new Error("Ad code not found");

  await db.affiliate_codes.delete({ where: { id: existing.id } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "ads_code_deleted",
    targetUserId: houseUserId,
    metadata: { code: value },
  });

  revalidatePath("/creators/ads");
  revalidatePath(`/creators/ads/${value}`);
}

// ---------------------------------------------------------------------------
// User search — for the initial house-account picker. Scoped to this
// page's permission so support / marketing don't get a generic user
// search they couldn't otherwise reach.
// ---------------------------------------------------------------------------

export async function searchUsersForHouse(query: string) {
  await requirePageAccess("/creators/ads");

  const q = query.trim();
  if (q.length < 2) return [];

  const users = await db.user.findMany({
    where: {
      OR: [
        { username: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { id: q },
      ],
    },
    select: { id: true, username: true, email: true },
    take: 10,
  });

  return users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
  }));
}
