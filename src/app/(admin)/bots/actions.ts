"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";

export async function toggleBotActive(botId: string, isActive: boolean) {
  await requireAdmin();

  await db.bots.update({
    where: { id: botId },
    data: { is_active: isActive },
  });

  revalidatePath("/bots");
}

export async function createBot(data: { username: string; imageUrl: string | null }) {
  await requireAdmin();

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
  await requireAdmin();

  await db.bots.update({
    where: { id: botId },
    data: {
      username: data.username,
      image_url: data.imageUrl || null,
    },
  });

  revalidatePath("/bots");
}
