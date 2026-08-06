"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { publishCreatorAgreementTerms } from "@/lib/creator-agreement-terms";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";

const PublishSchema = z.object({
  lines: z
    .array(z.string().trim().min(1, "Terms cannot contain an empty line").max(1_000))
    .min(1, "Add at least one term")
    .max(100, "Terms are limited to 100 lines"),
});

export async function publishCreatorTermsAction(input: {
  lines: string[];
}): Promise<
  | { success: true; version: number; publishedAt: string }
  | { success: false; error: string }
> {
  const session = await requireCreatorHubAccess(
    "Not authorized to publish creator agreement terms.",
  );
  const parsed = PublishSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid terms",
    };
  }

  try {
    const published = await publishCreatorAgreementTerms({
      lines: parsed.data.lines,
      actorAdminUserId: session.userId,
    });
    revalidatePath("/creator-hub/tos");
    return {
      success: true,
      version: published.version,
      publishedAt: published.publishedAt,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not publish creator terms.",
    };
  }
}
