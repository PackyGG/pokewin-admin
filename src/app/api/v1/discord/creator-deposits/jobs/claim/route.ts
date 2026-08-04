import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { claimCreatorDepositJobs } from "@/lib/discord-creator-deposits";
import { claimCreatorSignupJobs } from "@/lib/discord-creator-signups";
import { CREATOR_SETUP_GUILD_ID } from "@/lib/discord-creator-setups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  guildId: z.literal(CREATOR_SETUP_GUILD_ID),
  workerId: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(10),
});

export const POST = withApiKey(
  { scopes: ["discord:creator:setup"] },
  async (request) => {
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Invalid creator deposit claim.",
      );
    }
    const [jobs, signupJobs] = await Promise.all([
      claimCreatorDepositJobs(parsed.data),
      claimCreatorSignupJobs(parsed.data),
    ]);
    return { jobs, signupJobs };
  },
);
