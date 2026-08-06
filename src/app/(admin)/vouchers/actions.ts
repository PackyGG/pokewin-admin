"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq, ilike, or, sql } from "drizzle-orm";

import { adminDrizzle, getPrimaryDrizzleDb } from "@/lib/drizzle";
import { getReadDrizzleDb } from "@/lib/db";
import { admin_voucher_actions } from "@/lib/db-schema/admin/schema";
import { user } from "@/lib/db-schema/main/schema";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEventDurable } from "@/lib/admin-audit";
import { require2FA } from "@/lib/require-2fa";
import { checkBalanceAdjustmentLimit } from "@/lib/balance-limits";
import { usdAmountSchema } from "@/lib/utils/money";
import { escapeLikePattern } from "@/lib/utils/sql-like";

/**
 * A voucher IS a card (same value, same inventory / P&L treatment), so
 * creating one mints real, redeemable value against the house exactly like a
 * balance credit does. It is therefore gated the same way every other
 * player-crediting action is: page access → capability → TOTP/passkey →
 * per-admin spend cap.
 */
const createVoucherSchema = z.object({
  userId: z.string().min(1, "User is required"),
  // `usdAmountSchema` instead of a bare `z.number()`: the column is
  // Decimal(20,2), so a sub-cent value like 17.878 used to be silently
  // rounded to $17.88 on write. Rejected now rather than quietly changed.
  value: usdAmountSchema({ positive: true }).refine(
    (n) => n <= 10_000_000,
    { message: "Value must be $10,000,000 or less" },
  ),
  description: z.string().trim().max(500).optional(),
  totpCode: z.string().trim().min(1, "A 2FA code or passkey is required"),
});

export async function searchUsers(query: string) {
  // Auth first — never grab a DB handle before the caller is verified.
  await requirePageAccess("/vouchers");
  const db = await getReadDrizzleDb();

  if (!query || query.length < 2) return [];

  // Escaped so a pasted "%" / "_" matches literally instead of widening the
  // pattern into a full-table scan on MAIN.
  const pattern = `%${escapeLikePattern(query)}%`;
  const users = await db
    .select({ id: user.id, username: user.username, email: user.email })
    .from(user)
    .where(
      or(
        ilike(user.username, pattern),
        ilike(user.email, pattern),
        eq(user.id, query),
      ),
    )
    .limit(10);

  return users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
  }));
}

export async function createVoucher(data: z.infer<typeof createVoucherSchema>) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/vouchers");
  await requireCapability(session, "__can_create_voucher", "create vouchers");

  const parsed = createVoucherSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid voucher input");
  }

  // Second factor + per-admin spend cap, matching `adjustBalance`. Minting a
  // voucher is a credit to the player in everything but name, so it can't sit
  // behind a capability alone while a $1 balance adjustment needs a code.
  await require2FA(session.userId, parsed.data.totpCode);
  await checkBalanceAdjustmentLimit(session.userId, parsed.data.value);

  const [targetUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, parsed.data.userId))
    .limit(1);
  if (!targetUser) throw new Error("User not found");

  // NOTE: This uses raw SQL because the 'manual' origin is not in the
  // voucher_origin enum in the MAIN Drizzle schema. Either the DB enum has
  // been updated out-of-band or this flow was never exercised — either
  // way, using the generated enum column type here is invalid. Keep this as
  // parameterized raw SQL until the schema drift is resolved.
  const voucherResult = await db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (user_id, value, origin, description)
    VALUES (
      ${parsed.data.userId},
      ${String(parsed.data.value)},
      'manual',
      ${parsed.data.description || null}
    )
    RETURNING id
  `);
  const voucher = voucherResult.rows[0];
  if (!voucher) throw new Error("Voucher creation failed");

  // Best-effort side record. The voucher row (real value) is already
  // committed on MAIN, so a failure here must not throw the operator back
  // into a retry that mints a SECOND voucher.
  try {
    await adminDrizzle.insert(admin_voucher_actions).values({
      voucher_id: voucher.id,
      action: "created",
      admin_user_id: session.userId,
    });
  } catch (err) {
    console.error(
      "[createVoucher] admin_voucher_actions write failed (voucher already created):",
      err,
    );
  }

  // DURABLE: the voucher exists on MAIN by now. A throwing audit write used
  // to surface as a generic dialog error and invite a retry — a second
  // voucher for the same payout. `amountUsd` mirrors `value` so the minted
  // amount counts against the admin's spend cap (see `sumPeriodUsage`).
  const auditOutcome = await createAdminAuditEventDurable({
    adminUserId: session.userId,
    eventType: "voucher_created",
    targetUserId: parsed.data.userId,
    metadata: {
      voucher_id: voucher.id,
      value: parsed.data.value,
      amountUsd: parsed.data.value,
    },
  });
  if (auditOutcome.status !== "recorded") {
    console.error(
      "[createVoucher] audit event did not reach admin_audit_events (voucher already created):",
      { status: auditOutcome.status, voucherId: voucher.id },
    );
  }

  revalidatePath("/vouchers");
}
