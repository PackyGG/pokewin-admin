import { redirect } from "next/navigation";
import { getPendingSession } from "@/lib/session";
import { generateTOTPUri, generateQRCode } from "@/lib/totp";
import { SetupForm } from "./setup-form";

export const metadata = { title: "Setup 2FA" };

export default async function Setup2FAPage() {
  const pending = await getPendingSession();
  if (!pending) redirect("/login");

  // Secret lives inside the signed pending-session cookie (minted by
  // the login action). If it's absent the user is on the verify path
  // or their session expired — send them through verify-2fa which the
  // middleware already enforces as the default pending route.
  if (!pending.totpSecret) redirect("/verify-2fa");

  const secret = pending.totpSecret;

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
