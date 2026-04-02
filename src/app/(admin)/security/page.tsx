import { requirePageAccess } from "@/lib/dal";
import { getSiteConfig } from "@/lib/queries/security";
import { SecurityContent } from "./security-content";

export default async function SecurityPage() {
  await requirePageAccess("/security");
  const config = await getSiteConfig();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Security</h1>
      <SecurityContent config={config} />
    </div>
  );
}
