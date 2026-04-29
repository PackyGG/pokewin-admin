"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";

export async function toggleBotActive(botId: string, isActive: boolean) {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_toggle_bot_active", "toggle bot active state");

  await db.bots.update({
    where: { id: botId },
    data: { is_active: isActive },
  });

  revalidatePath("/bots");
}

export async function createBot(data: { username: string; imageUrl: string | null }) {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_create_bot", "create bots");

  await db.bots.create({
    data: {
      id: crypto.randomUUID(),
      username: data.username,
      image_url: data.imageUrl || null,
    },
  });

  revalidatePath("/bots");
}

export async function updateBot(
  botId: string,
  data: { username: string; imageUrl: string | null }
) {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_update_bot", "update bots");

  await db.bots.update({
    where: { id: botId },
    data: {
      username: data.username,
      image_url: data.imageUrl || null,
    },
  });

  revalidatePath("/bots");
}
