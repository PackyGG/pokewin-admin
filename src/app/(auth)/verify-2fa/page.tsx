import { redirect } from "next/navigation";
import { getPendingSession } from "@/lib/session";
import { adminDb } from "@/lib/admin-db";
import { VerifyForm } from "./verify-form";

export const metadata = { title: "Verify 2FA" };

export default async function Verify2FAPage() {
  const pending = await getPendingSession();
  if (!pending) redirect("/login");

  // Only offer the passkey option to accounts that have registered one.
  // Resilient: a count failure degrades to "no passkeys" so the TOTP form
  // always renders.
  let hasPasskeys = false;
  try {
    hasPasskeys =
      (await adminDb.admin_passkeys.count({
        where: { admin_user_id: pending.adminUserId },
      })) > 0;
  } catch {
    hasPasskeys = false;
  }

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/40 sm:p-10">
      {/* Hairline top light-catch — a crisp cyan lifted edge. Decorative. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent"
      />
      <div className="relative mb-8 text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
          Secure Access
        </p>
        <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">Two-Factor Authentication</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Enter the 6-digit code from your authenticator app
        </p>
      </div>
      <div className="relative">
        <VerifyForm hasPasskeys={hasPasskeys} />
      </div>
    </div>
  );
}
