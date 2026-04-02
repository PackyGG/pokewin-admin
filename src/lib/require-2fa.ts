import { adminDb } from "@/lib/admin-db";
import { verifyTOTP } from "@/lib/totp";

export async function require2FA(
  adminUserId: string,
  totpCode: string | undefined
): Promise<void> {
  if (!totpCode || totpCode.trim().length === 0) {
    throw new Error("TOTP code is required for this action");
  }

  const adminUser = await adminDb.admin_users.findUnique({
    where: { id: adminUserId },
    select: { totp_secret: true, totp_enabled: true },
  });

  if (!adminUser) {
    throw new Error("Admin user not found");
  }

  if (!adminUser.totp_enabled || !adminUser.totp_secret) {
    throw new Error("2FA is not enabled for this admin account");
  }

  const isValid = verifyTOTP(adminUser.totp_secret, totpCode.trim());
  if (!isValid) {
    throw new Error("Invalid TOTP code");
  }
}
