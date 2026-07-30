import { IdentifierBlocklistPage } from "../_components/identifier-blocklist-page";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";

export const metadata = { title: "Fingerprint Blacklist · Antifraud" };

export default async function FingerprintBlacklistPage() {
  await requireAntifraudPageAccess();
  return <IdentifierBlocklistPage kind="fingerprint" />;
}
