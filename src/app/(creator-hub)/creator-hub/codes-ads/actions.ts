"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";
import { requireCapability } from "@/lib/require-capability";
import {
  SETTINGS_KEYS,
  getAdminSetting,
  setAdminSetting,
} from "@/lib/admin-settings";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { HUB_CODES_ADS_PATH } from "./_lib/tab";

const HUB_REVALIDATE_PATHS = [HUB_CODES_ADS_PATH, "/creators/ads", "/creators/codes"];

const setHouseAccountSchema = z.object({
  userId: z
    .string()
    .trim()
    .min(1, "User id is required")
    .max(64, "User id is too long"),
});

export async function setHouseAccount(userId: string) {
  const db = await getDb();
  const session = await requireCreatorHubAccess();
  await requireCapability(session, "__can_set_house_account", "set the ads house account");

  const parsed = setHouseAccountSchema.safeParse({ userId });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid user id");
  }

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

  for (const path of HUB_REVALIDATE_PATHS) revalidatePath(path);
}

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
  const db = await getDb();
  const session = await requireCreatorHubAccess();
  await requireCapability(session, "__can_create_ad_code", "create ad codes");

  const parsed = codeSchema.safeParse(code);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid code");
  }
  const value = parsed.data;

  const houseUserId = await getRequiredHouseUserId();

  const houseUser = await db.user.findUnique({
    where: { id: houseUserId },
    select: { id: true },
  });
  if (!houseUser) throw new Error("House account no longer exists");

  const existing = await db.affiliate_codes.findUnique({
    where: { code: value },
  });
  if (existing) throw new Error("This code is already taken");

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

  for (const path of HUB_REVALIDATE_PATHS) revalidatePath(path);
}

export async function deleteAdCode(code: string) {
  const db = await getDb();
  const session = await requireCreatorHubAccess();
  await requireCapability(session, "__can_delete_ad_code", "delete ad codes");

  const parsed = codeSchema.safeParse(code);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid code");
  }
  const value = parsed.data;

  const houseUserId = await getRequiredHouseUserId();

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

  for (const path of HUB_REVALIDATE_PATHS) revalidatePath(path);
  revalidatePath(`/creators/ads/${value}`);
}

export async function searchUsersForHouse(query: string) {
  const db = await getDb();
  await requireCreatorHubAccess();

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
