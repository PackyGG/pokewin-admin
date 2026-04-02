"use server";

import { revalidatePath } from "next/cache";
import { whitelistPool } from "@/lib/whitelist-db";
import { requireAdmin } from "@/lib/dal";

function generateReferralCode(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const sections = [8, 4, 4, 4, 12];
  return sections
    .map((len) =>
      Array.from({ length: len }, () =>
        chars[Math.floor(Math.random() * chars.length)]
      ).join("")
    )
    .join("-");
}

export async function addWhitelistUser(discordId: string, username: string) {
  await requireAdmin();

  if (!discordId.trim() || !username.trim()) {
    throw new Error("Discord ID and username are required");
  }

  const id = crypto.randomUUID();
  const referralCode = generateReferralCode();

  await whitelistPool.query(
    `INSERT INTO "User" (id, "discordId", username, "referralCode") VALUES ($1, $2, $3, $4)`,
    [id, discordId.trim(), username.trim(), referralCode]
  );

  revalidatePath("/whitelist");
}

export async function deleteWhitelistUser(userId: string) {
  await requireAdmin();

  await whitelistPool.query(`DELETE FROM "Event" WHERE "userId" = $1`, [userId]);
  await whitelistPool.query(`DELETE FROM "User" WHERE id = $1`, [userId]);

  revalidatePath("/whitelist");
}
