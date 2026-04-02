import { redirect } from "next/navigation";
import { getPendingSession } from "@/lib/session";
import { VerifyForm } from "./verify-form";

export default async function Verify2FAPage() {
  const pending = await getPendingSession();
  if (!pending) redirect("/login");

  return (
    <div className="w-[520px] max-w-full rounded-2xl border border-white/10 bg-white/5 p-12 shadow-2xl shadow-black/30 backdrop-blur-xl">
      <div className="mb-8 text-center">
        <h1 className="text-xl font-semibold text-foreground">Two-Factor Authentication</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Enter the 6-digit code from your authenticator app
        </p>
      </div>
      <VerifyForm />
    </div>
  );
}
