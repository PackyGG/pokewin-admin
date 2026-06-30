import "server-only";
import crypto from "crypto";
import type { getDb } from "@/lib/db";

/**
 * Generate a unique random replacement affiliate code.
 *
 * Source-of-truth helper shared by every affiliate-code transfer flow
 * (`transferAffiliateCode` in src/app/(admin)/users/[id]/actions.ts and
 * `transferAffiliateCodeToMotha` in the Insights Affiliate Codes page) so
 * a stripped previous owner is never left codeless and the generation /
 * uniqueness mechanism is identical everywhere — no parallel random-code
 * logic.
 *
 * Uses a confusable-free alphabet (no I/L/O/0/1) and retries on the
 * (extremely unlikely) collision, checking uniqueness against the live
 * `affiliate_codes.code` unique index.
 */
export async function generateRandomAffiliateCode(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<string> {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const length = 10;
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = "";
    for (let i = 0; i < length; i++) {
      code += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    const exists = await db.affiliate_codes.findUnique({
      where: { code },
      select: { user_id: true },
    });
    if (!exists) return code;
  }
  throw new Error("Could not generate a unique replacement affiliate code");
}
