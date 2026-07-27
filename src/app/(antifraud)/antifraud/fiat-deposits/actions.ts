"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { updateFiatReview } from "@/lib/antifraud/fiat-deposits-api";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";

const schema = z
  .object({
    depositIntentId: z.string().uuid(),
    action: z.enum(["start_review", "clear", "escalate", "recommend_hold"]),
    note: z.string().trim().max(1_000),
    expectedStatus: z.enum([
      "unreviewed",
      "in_review",
      "cleared",
      "escalated",
      "hold_recommended",
    ]),
    idempotencyKey: z.string().uuid(),
  })
  .superRefine((value, context) => {
    if (value.action !== "start_review" && value.note.length < 4) {
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "Write what you concluded before recording this decision.",
      });
    }
  });

export async function setFiatReviewState(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  await updateFiatReview({
    ...parsed.data,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
    note: parsed.data.note || undefined,
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_fiat_deposit_reviewed",
    metadata: parsed.data,
  });
  revalidatePath("/antifraud/fiat-deposits");
  revalidatePath(`/antifraud/fiat-deposits/${parsed.data.depositIntentId}`);
}
