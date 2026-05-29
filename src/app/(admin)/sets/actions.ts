"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { uploadImage } from "@/lib/imagekit";

export async function uploadSetImage(formData: FormData): Promise<string> {
  const session = await requireAdmin();
  await requireCapability(session, "__can_upload_set_image", "upload set images");

  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("No file provided");
  if (!file.type.startsWith("image/")) throw new Error("File must be an image");
  if (file.size > 5 * 1024 * 1024) throw new Error("File must be under 5MB");

  const buffer = Buffer.from(await file.arrayBuffer());
  const url = await uploadImage(buffer, file.name, "/sets");
  return url;
}

export async function createSet(data: {
  name: string;
  series: string;
  imageUrl: string;
  language: string;
  tcgplayerId: number;
  releaseDate: string | null;
}): Promise<string> {
  const db = await getDb();
  const session = await requireAdmin();

  if (!data.name.trim()) throw new Error("Name is required");
  if (!data.series.trim()) throw new Error("Series is required");
  if (!data.imageUrl) throw new Error("Image is required");
  if (!data.language.trim()) throw new Error("Language is required");
  if (!Number.isInteger(data.tcgplayerId)) {
    throw new Error("TCGPlayer ID must be a whole number");
  }

  await requireCapability(session, "__can_create_set", "create sets");

  let releaseDate: Date | null = null;
  if (data.releaseDate) {
    const parsed = new Date(data.releaseDate);
    if (Number.isNaN(parsed.getTime())) throw new Error("Invalid release date");
    releaseDate = parsed;
  }

  let set;
  try {
    set = await db.sets.create({
      data: {
        name: data.name.trim(),
        series: data.series.trim(),
        image_url: data.imageUrl,
        language: data.language.trim(),
        tcgplayer_id: data.tcgplayerId,
        release_date: releaseDate,
      },
    });
  } catch (e) {
    // tcgplayer_id carries a unique constraint — surface a friendly
    // message instead of leaking the raw Prisma error.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      throw new Error("A set with that TCGPlayer ID already exists");
    }
    throw e;
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "set_created",
    metadata: { set_id: set.id, name: data.name, series: data.series },
  });

  revalidatePath("/sets");
  // The card-create dropdown reads from the same table.
  revalidatePath("/cards");
  return set.id;
}
