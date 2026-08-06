import { AlertTriangle, Radio } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { safeQuery } from "@/lib/errors/safe-query";
import { requireOwner } from "@/lib/owners";
import { getActiveEosBattles } from "@/lib/queries/eos-active-preview";
import { LiveBattleRows } from "./live-battle-rows";

export const metadata = { title: "Live EOS Battle Preview" };
export const revalidate = 0;

const LIST_TIMEOUT_MS = 10_000;

/** Owner-only early view of active battle outcomes and creator economics. */
export default async function EosVerificationPage() {
  await requireOwner();

  const result = await safeQuery(
    getActiveEosBattles,
    [],
    "eos-active-preview.list",
    LIST_TIMEOUT_MS,
  );

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="space-y-1">
          <SectionHeading icon={Radio} title="Live EOS Battle Preview" />
          <p className="text-xs text-muted-foreground">
            Active outcomes and creator payout values appear as soon as
            settlement commits, before the player animation finishes.
          </p>
        </div>
        {result.error ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Couldn&apos;t load active battles. Refresh to retry.
            </p>
          </div>
        ) : (
          <LiveBattleRows battles={result.data} />
        )}
      </section>
    </div>
  );
}
