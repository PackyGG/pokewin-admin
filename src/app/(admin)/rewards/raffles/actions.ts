"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { reloadPacks } from "@/app/(admin)/rewards/actions";
import { toNumber } from "@/lib/utils/decimal";

export type SearchItem = {
  id: string;
  type: "pack" | "card";
  name: string;
  imageUrl: string | null;
  priceUsd: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function searchItems(
  query: string,
  type: "pack" | "card",
  filters?: { minPrice?: number; maxPrice?: number },
): Promise<SearchItem[]> {
  await requirePageAccess("/rewards/raffles");
  const isUuid = UUID_RE.test(query);

  const priceFilter: Record<string, unknown> = {};
  if (filters?.minPrice != null) priceFilter.gte = filters.minPrice;
  if (filters?.maxPrice != null) priceFilter.lte = filters.maxPrice;
  const hasPriceFilter = Object.keys(priceFilter).length > 0;

  if (type === "pack") {
    const or: Record<string, unknown>[] = [];
    if (query) {
      or.push({ name: { contains: query, mode: "insensitive" } });
      or.push({ slug: { contains: query, mode: "insensitive" } });
      if (isUuid) or.push({ id: query });
    }
    const where: Record<string, unknown> = {};
    if (or.length > 0) where.OR = or;
    if (hasPriceFilter) where.price = priceFilter;

    const packs = await db.packs.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      select: { id: true, name: true, image_url: true, price: true },
      orderBy: { name: "asc" },
      take: 20,
    });
    return packs.map((p) => ({
      id: p.id,
      type: "pack",
      name: p.name,
      imageUrl: p.image_url,
      priceUsd: toNumber(p.price),
    }));
  }

  const or: Record<string, unknown>[] = [];
  if (query) {
    or.push({ name: { contains: query, mode: "insensitive" } });
    if (isUuid) or.push({ id: query });
  }
  const where: Record<string, unknown> = {};
  if (or.length > 0) where.OR = or;
  if (hasPriceFilter) where.price = priceFilter;

  const cards = await db.cards.findMany({
    where: Object.keys(where).length > 0 ? where : undefined,
    select: { id: true, name: true, image_url: true, price: true },
    orderBy: { name: "asc" },
    take: 20,
  });
  return cards.map((c) => ({
    id: c.id,
    type: "card",
    name: c.name,
    imageUrl: c.image_url,
    priceUsd: toNumber(c.price),
  }));
}

export async function createRaffle(data: {
  name: string;
  description?: string;
  startsAt: string;
  endsAt: string;
  minPointsPerEntry?: number;
  maxPointsPerEntry?: number;
  prizes: { type: "pack" | "card"; id: string; quantity: number }[];
}) {
  const session = await requirePageAccess("/rewards/raffles");

  const res = await fetch(
    `${process.env.BACKEND_API_URL}/admin/raffles`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.BACKEND_API_KEY!,
      },
      body: JSON.stringify({
        name: data.name,
        description: data.description,
        prizes: data.prizes,
        min_points_per_entry: data.minPointsPerEntry,
        max_points_per_entry: data.maxPointsPerEntry,
        starts_at: new Date(data.startsAt).toISOString(),
        ends_at: new Date(data.endsAt).toISOString(),
      }),
    },
  );

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(body?.message ?? "Failed to create raffle");
  }

  const raffleId = body?.data?.raffle?.id ?? body?.raffle?.id ?? body?.id;
  if (!raffleId) {
    console.error("Unexpected raffle API response:", JSON.stringify(body));
    throw new Error("Unexpected API response");
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "raffle_created",
    metadata: { raffle_id: raffleId, name: data.name },
  });

  await reloadPacks();

  revalidatePath("/rewards/raffles");
  return raffleId;
}

export async function updateRaffle(
  id: string,
  data: {
    name: string;
    description?: string;
    startsAt: string;
    endsAt: string;
    minPointsPerEntry?: number;
    maxPointsPerEntry?: number;
    prizes: { type: "pack" | "card"; id: string; quantity: number }[];
  },
) {
  const session = await requirePageAccess("/rewards/raffles");

  const raffle = await db.raffles.findUnique({ where: { id } });
  if (!raffle) throw new Error("Raffle not found");
  if (raffle.status !== "active") throw new Error("Only active raffles can be edited");

  await db.raffles.update({
    where: { id },
    data: {
      name: data.name,
      description: data.description ?? null,
      starts_at: new Date(data.startsAt),
      ends_at: new Date(data.endsAt),
      min_points_per_entry: data.minPointsPerEntry ?? null,
      max_points_per_entry: data.maxPointsPerEntry ?? null,
      prizes: data.prizes,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "raffle_updated",
    metadata: { raffle_id: id, name: data.name },
  });

  revalidatePath("/rewards/raffles");
  revalidatePath(`/rewards/raffles/${id}`);
}

export async function cancelRaffle(id: string) {
  const session = await requirePageAccess("/rewards/raffles");

  const raffle = await db.raffles.findUnique({ where: { id } });
  if (!raffle) throw new Error("Raffle not found");
  if (raffle.status !== "active") throw new Error("Only active raffles can be cancelled");

  await db.raffles.update({
    where: { id },
    data: { status: "cancelled" },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "raffle_cancelled",
    metadata: { raffle_id: id },
  });

  revalidatePath("/rewards/raffles");
  revalidatePath(`/rewards/raffles/${id}`);
}
