"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { reloadPacks } from "@/app/(admin)/rewards/actions";
import { toNumber } from "@/lib/utils/decimal";

const prizeSchema = z.object({
  type: z.enum(["pack", "card"]),
  id: z.string().min(1, "Prize id is required"),
  quantity: z.number().int().positive("Prize quantity must be at least 1"),
});

const createRaffleSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name is too long"),
  description: z.string().trim().max(500, "Description is too long").optional(),
  startsAt: z.string().min(1, "Start date is required"),
  endsAt: z.string().min(1, "End date is required"),
  minPointsPerEntry: z.number().int().nonnegative().optional(),
  maxPointsPerEntry: z.number().int().nonnegative().optional(),
  prizes: z.array(prizeSchema).min(1, "At least one prize is required"),
});

const updateRaffleSchema = createRaffleSchema;

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
}): Promise<string> {
  const session = await requirePageAccess("/rewards/raffles");

  // 1. Validate input shape
  const parseResult = createRaffleSchema.safeParse(data);
  if (!parseResult.success) {
    throw new Error(parseResult.error.issues[0]?.message ?? "Invalid input");
  }
  const parsed = parseResult.data;

  // 2. Validate dates — new Date(...) returns "Invalid Date" on garbage
  // input, and a later .toISOString() call would panic with RangeError,
  // which bubbles up as a masked server error in production.
  const startsAtDate = new Date(parsed.startsAt);
  const endsAtDate = new Date(parsed.endsAt);
  if (Number.isNaN(startsAtDate.getTime())) {
    throw new Error("Invalid start date");
  }
  if (Number.isNaN(endsAtDate.getTime())) {
    throw new Error("Invalid end date");
  }
  if (endsAtDate <= startsAtDate) {
    throw new Error("End date must be after start date");
  }
  if (
    parsed.minPointsPerEntry != null &&
    parsed.maxPointsPerEntry != null &&
    parsed.maxPointsPerEntry < parsed.minPointsPerEntry
  ) {
    throw new Error("Max points per entry must be greater than or equal to min");
  }

  // 3. Env var check — without this, fetch() receives "undefined/admin/raffles"
  // and throws an opaque TypeError that becomes a "Server Components render"
  // error in production.
  const backendUrl = process.env.BACKEND_API_URL;
  const backendKey = process.env.BACKEND_API_KEY;
  if (!backendUrl) {
    throw new Error("BACKEND_API_URL is not configured on the server");
  }
  if (!backendKey) {
    throw new Error("BACKEND_API_KEY is not configured on the server");
  }

  // 4. Call backend — wrap in try/catch so network errors surface cleanly
  // instead of masking as a generic RSC render error.
  let res: Response;
  try {
    res = await fetch(`${backendUrl}/admin/raffles`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": backendKey,
      },
      body: JSON.stringify({
        name: parsed.name,
        description: parsed.description,
        prizes: parsed.prizes,
        min_points_per_entry: parsed.minPointsPerEntry,
        max_points_per_entry: parsed.maxPointsPerEntry,
        starts_at: startsAtDate.toISOString(),
        ends_at: endsAtDate.toISOString(),
      }),
    });
  } catch (err) {
    console.error("[createRaffle] Failed to reach backend:", err);
    const message = err instanceof Error ? err.message : "Unknown network error";
    throw new Error(`Failed to reach backend: ${message}`);
  }

  const body = (await res.json().catch(() => null)) as {
    message?: string;
    data?: { raffle?: { id?: string } };
    raffle?: { id?: string };
    id?: string;
  } | null;

  if (!res.ok) {
    const backendMessage = body?.message ?? `Backend returned HTTP ${res.status}`;
    console.error(
      "[createRaffle] Backend error:",
      res.status,
      JSON.stringify(body),
    );
    throw new Error(backendMessage);
  }

  const raffleId = body?.data?.raffle?.id ?? body?.raffle?.id ?? body?.id;
  if (!raffleId || typeof raffleId !== "string") {
    console.error(
      "[createRaffle] Unexpected backend response shape:",
      JSON.stringify(body),
    );
    throw new Error("Backend returned an unexpected response shape");
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "raffle_created",
    metadata: { raffle_id: raffleId, name: parsed.name },
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
): Promise<void> {
  const session = await requirePageAccess("/rewards/raffles");

  const parseResult = updateRaffleSchema.safeParse(data);
  if (!parseResult.success) {
    throw new Error(parseResult.error.issues[0]?.message ?? "Invalid input");
  }
  const parsed = parseResult.data;

  const startsAtDate = new Date(parsed.startsAt);
  const endsAtDate = new Date(parsed.endsAt);
  if (Number.isNaN(startsAtDate.getTime())) {
    throw new Error("Invalid start date");
  }
  if (Number.isNaN(endsAtDate.getTime())) {
    throw new Error("Invalid end date");
  }
  if (endsAtDate <= startsAtDate) {
    throw new Error("End date must be after start date");
  }
  if (
    parsed.minPointsPerEntry != null &&
    parsed.maxPointsPerEntry != null &&
    parsed.maxPointsPerEntry < parsed.minPointsPerEntry
  ) {
    throw new Error("Max points per entry must be greater than or equal to min");
  }

  const raffle = await db.raffles.findUnique({ where: { id } });
  if (!raffle) throw new Error("Raffle not found");
  if (raffle.status !== "active") throw new Error("Only active raffles can be edited");

  await db.raffles.update({
    where: { id },
    data: {
      name: parsed.name,
      description: parsed.description ?? null,
      starts_at: startsAtDate,
      ends_at: endsAtDate,
      min_points_per_entry: parsed.minPointsPerEntry ?? null,
      max_points_per_entry: parsed.maxPointsPerEntry ?? null,
      prizes: parsed.prizes,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "raffle_updated",
    metadata: { raffle_id: id, name: parsed.name },
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
