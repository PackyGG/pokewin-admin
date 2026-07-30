import { IdentifierBlocklistPage } from "../_components/identifier-blocklist-page";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";

export const metadata = { title: "IP Blacklist · Antifraud" };

export default async function IpBlacklistPage() {
  await requireAntifraudPageAccess();
  return <IdentifierBlocklistPage kind="ip" />;
}
