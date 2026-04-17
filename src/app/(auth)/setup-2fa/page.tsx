import { redirect } from "next/navigation";
import {
  getPendingSession,
  getTOTPSetupCookie,
  createTOTPSetupCookie,
} from "@/lib/session";
import { generateSecret, generateTOTPUri, generateQRCode } from "@/lib/totp";
import { SetupForm } from "./setup-form";

export const metadata = { title: "Setup 2FA" };

export default async function Setup2FAPage() {
  const pending = await getPendingSession();
  if (!pending) redirect("/login");

  // The TOTP secret must be bound to the server-side pending session and
  // must NOT be trusted from the client form post. Previously the secret
  // was embedded as a hidden <input> and passed back to confirmSetup —
  // an attacker could submit a secret they already knew and bypass 2FA.
  // We now generate (or reuse) the secret in a signed, httpOnly cookie
  // tied to this pending admin user; confirmSetup reads it from the
  // cookie instead of the form body.
  const existingSetup = await getTOTPSetupCookie();
  let secret: string;
  if (existingSetup && existingSetup.adminUserId === pending.adminUserId) {
    secret = existingSetup.secret;
  } else {
    secret = generateSecret();
    await createTOTPSetupCookie({
      secret,
      adminUserId: pending.adminUserId,
    });
  }

  const uri = generateTOTPUri(secret, pending.email);
  const qrCodeDataUrl = await generateQRCode(uri);

  return (
    <div className="w-[520px] max-w-full rounded-2xl border border-white/10 bg-white/5 p-12 shadow-2xl shadow-black/30 backdrop-blur-xl">
      <div className="mb-8 text-center">
        <h1 className="text-xl font-semibold text-foreground">Set up Two-Factor Authentication</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Scan the QR code with your authenticator app (Google Authenticator, Authy, etc.)
        </p>
      </div>
      <SetupForm qrCodeDataUrl={qrCodeDataUrl} />
    </div>
  );
}
