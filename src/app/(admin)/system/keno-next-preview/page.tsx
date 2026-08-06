import { Dices } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { requireOwner } from "@/lib/owners";
import { KenoNextPreviewClient } from "./keno-next-preview-client";
import { TARGET_KENO_USER_ID } from "./types";

export const metadata = { title: "Keno Next Preview" };
export const revalidate = 0;

export default async function KenoNextPreviewPage() {
  await requireOwner();

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="space-y-1">
          <SectionHeading icon={Dices} title="Keno Next Preview" />
          <p className="text-xs text-muted-foreground">
            Owner-only next-draw simulator locked to {TARGET_KENO_USER_ID}.
          </p>
        </div>
        <KenoNextPreviewClient targetUserId={TARGET_KENO_USER_ID} />
      </section>
    </div>
  );
}
