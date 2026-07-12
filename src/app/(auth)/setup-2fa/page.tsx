import { redirect } from "next/navigation";
import { getPendingSession, getSession } from "@/lib/session";
import { generateTOTPUri, generateQRCode } from "@/lib/totp";
import { SetupForm } from "./setup-form";
import { SetupBootstrap } from "./setup-bootstrap";

export const metadata = { title: "Setup 2FA" };

export default async function Setup2FAPage() {
  const pending = await getPendingSession();

  // No pending cookie. Two cases:
  //   • A logged-in admin sent here by `verifySession`'s Phase D mandatory-2FA
  //     guard (authenticated, but not enrolled) — they have a real
  //     `admin_session` but no pending cookie. Render the bootstrap trigger,
  //     which mints a pending session from that real session (via a Server
  //     Action) and reloads so the QR renders. This is the loop-free bridge for
  //     the middleware exception that lets an authenticated user reach this page.
  //   • Anyone else (no session at all) → /login.
  if (!pending) {
    const session = await getSession();
    if (!session) redirect("/login");
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
          <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">Set up Two-Factor Authentication</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Two-factor authentication is required. Finishing setup…
          </p>
        </div>
        <div className="relative">
          <SetupBootstrap />
        </div>
      </div>
    );
  }

  // Secret lives inside the signed pending-session cookie (minted by
  // the login action). If it's absent the user is on the verify path
  // or their session expired — send them through verify-2fa which the
  // middleware already enforces as the default pending route.
  if (!pending.totpSecret) redirect("/verify-2fa");

  const secret = pending.totpSecret;

  const uri = generateTOTPUri(secret, pending.email);
  const qrCodeDataUrl = await generateQRCode(uri);

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
        <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">Set up Two-Factor Authentication</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Scan the QR code with your authenticator app (Google Authenticator, Authy, etc.)
        </p>
      </div>
      <div className="relative">
        <SetupForm qrCodeDataUrl={qrCodeDataUrl} />
      </div>
    </div>
  );
}
