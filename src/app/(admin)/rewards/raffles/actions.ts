"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { reloadPacks } from "@/app/(admin)/rewards/actions";
import { toNumber } from "@/lib/utils/decimal";
import { backendApi, BackendApiError } from "@/lib/backend-api";

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

// Raffle mutations return their error as a value instead of throwing.
// Next.js masks all thrown Server Action errors in production — the client
// receives a digest-only "An error occurred in the Server Components render"
// message with the real message stripped. Returning { success: false, error }
// lets the real message survive the RSC payload and surface in a toast.
// Matches the pattern used by createAffiliateCode in users/[id]/actions.ts.

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
  const db = await getDb();
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
}): Promise<
  | { success: true; raffleId: string }
  | { success: false; error: string }
> {
  const session = await requirePageAccess("/rewards/raffles");

  // 1. Validate input shape
  const parseResult = createRaffleSchema.safeParse(data);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const parsed = parseResult.data;

  // 2. Validate dates — new Date(...) returns "Invalid Date" on garbage
  // input, and a later .toISOString() call would panic with RangeError.
  const startsAtDate = new Date(parsed.startsAt);
  const endsAtDate = new Date(parsed.endsAt);
  if (Number.isNaN(startsAtDate.getTime())) {
    return { success: false, error: "Invalid start date" };
  }
  if (Number.isNaN(endsAtDate.getTime())) {
    return { success: false, error: "Invalid end date" };
  }
  if (endsAtDate <= startsAtDate) {
    return { success: false, error: "End date must be after start date" };
  }
  if (
    parsed.minPointsPerEntry != null &&
    parsed.maxPointsPerEntry != null &&
    parsed.maxPointsPerEntry < parsed.minPointsPerEntry
  ) {
    return {
      success: false,
      error: "Max points per entry must be greater than or equal to min",
    };
  }

  await requireCapability(session, "__can_create_raffle", "create raffles");

  // 3. Call backend via the central client — picks env-specific URL+key
  // (BACKEND_API_URL_PROD/_DEV + BACKEND_ADMIN_KEY_PROD/_DEV) based on the
  // `admin_db_env` cookie, attaches CF Access service tokens, and adds the
  // `x-bypass-secret` header. Avoids the env-split mismatch that bit when
  // this action read suffix-less BACKEND_API_URL/BACKEND_API_KEY directly
  // while every other admin action used the suffixed pair.
  type CreateRaffleResponse = {
    message?: string;
    data?: { raffle?: { id?: string } };
    raffle?: { id?: string };
    id?: string;
  };

  let body: CreateRaffleResponse;
  try {
    body = await backendApi.post<CreateRaffleResponse>("/admin/raffles", {
      name: parsed.name,
      description: parsed.description,
      prizes: parsed.prizes,
      min_points_per_entry: parsed.minPointsPerEntry,
      max_points_per_entry: parsed.maxPointsPerEntry,
      starts_at: startsAtDate.toISOString(),
      ends_at: endsAtDate.toISOString(),
    });
    console.log(
      `[createRaffle] backend ok name="${parsed.name}" prizes=${parsed.prizes.length}`,
    );
  } catch (err) {
    if (err instanceof BackendApiError) {
      console.error(
        `[createRaffle] backend error status=${err.status} code=${err.code ?? "none"} message="${err.message}" payload=${JSON.stringify(err.payload)}`,
      );
      return { success: false, error: err.message };
    }
    const message = err instanceof Error ? err.message : "Unknown network error";
    console.error(`[createRaffle] failed to reach backend: ${message}`, err);
    return { success: false, error: `Failed to reach backend: ${message}` };
  }

  const raffleId = body?.data?.raffle?.id ?? body?.raffle?.id ?? body?.id;
  if (!raffleId || typeof raffleId !== "string") {
    console.error(
      `[createRaffle] unexpected backend response shape: ${JSON.stringify(body)}`,
    );
    return {
      success: false,
      error: "Backend returned an unexpected response shape",
    };
  }

  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "raffle_created",
      metadata: { raffle_id: raffleId, name: parsed.name },
    });
  } catch (err) {
    // Raffle was created successfully on the backend — don't fail the whole
    // operation just because audit logging is broken. Log it loudly instead.
    console.error("[createRaffle] Audit logging failed:", err);
  }

  await reloadPacks();

  revalidatePath("/rewards/raffles");
  return { success: true, raffleId };
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
): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requirePageAccess("/rewards/raffles");

  const parseResult = updateRaffleSchema.safeParse(data);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const parsed = parseResult.data;

  const startsAtDate = new Date(parsed.startsAt);
  const endsAtDate = new Date(parsed.endsAt);
  if (Number.isNaN(startsAtDate.getTime())) {
    return { success: false, error: "Invalid start date" };
  }
  if (Number.isNaN(endsAtDate.getTime())) {
    return { success: false, error: "Invalid end date" };
  }
  if (endsAtDate <= startsAtDate) {
    return { success: false, error: "End date must be after start date" };
  }
  if (
    parsed.minPointsPerEntry != null &&
    parsed.maxPointsPerEntry != null &&
    parsed.maxPointsPerEntry < parsed.minPointsPerEntry
  ) {
    return {
      success: false,
      error: "Max points per entry must be greater than or equal to min",
    };
  }

  const raffle = await db.raffles.findUnique({ where: { id } });
  if (!raffle) return { success: false, error: "Raffle not found" };
  if (raffle.status !== "active") {
    return { success: false, error: "Only active raffles can be edited" };
  }

  await requireCapability(session, "__can_update_raffle", "update raffles");

  try {
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
  } catch (err) {
    console.error("[updateRaffle] DB update failed:", err);
    const message = err instanceof Error ? err.message : "Unknown DB error";
    return { success: false, error: `Failed to update raffle: ${message}` };
  }

  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "raffle_updated",
      metadata: { raffle_id: id, name: parsed.name },
    });
  } catch (err) {
    console.error("[updateRaffle] Audit logging failed:", err);
  }

  revalidatePath("/rewards/raffles");
  revalidatePath(`/rewards/raffles/${id}`);
  return { success: true };
}

export async function cancelRaffle(
  id: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requirePageAccess("/rewards/raffles");

  const raffle = await db.raffles.findUnique({ where: { id } });
  if (!raffle) return { success: false, error: "Raffle not found" };
  if (raffle.status !== "active") {
    return { success: false, error: "Only active raffles can be cancelled" };
  }

  await requireCapability(session, "__can_cancel_raffle", "cancel raffles");

  try {
    await db.raffles.update({
      where: { id },
      data: { status: "cancelled" },
    });
  } catch (err) {
    console.error("[cancelRaffle] DB update failed:", err);
    const message = err instanceof Error ? err.message : "Unknown DB error";
    return { success: false, error: `Failed to cancel raffle: ${message}` };
  }

  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "raffle_cancelled",
      metadata: { raffle_id: id },
    });
  } catch (err) {
    console.error("[cancelRaffle] Audit logging failed:", err);
  }

  revalidatePath("/rewards/raffles");
  revalidatePath(`/rewards/raffles/${id}`);
  return { success: true };
}
