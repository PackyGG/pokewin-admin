import { ArrowUpCircle, Coins, EyeOff, Layers, Sparkles } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import {
  getUpgraderPickerFilters,
  listUpgraderOutputs,
} from "./actions";
import { AddUpgraderCardsDialog } from "./add-cards-dialog";
import { UpgraderOutputCardsGrid } from "./output-cards-grid";

export const metadata = { title: "Upgrader" };

export default async function UpgraderAdminPage() {
  await requirePageAccess("/upgrader");

  const [outputs, filters] = await Promise.all([
    listUpgraderOutputs(),
    getUpgraderPickerFilters(),
  ]);

  const total = outputs.length;
  const enabled = outputs.filter((c) => c.enabled).length;
  const disabled = total - enabled;
  const totalValue = outputs.reduce((sum, c) => sum + c.price, 0);
  const avgPrice = total > 0 ? totalValue / total : 0;
  const maxPrice = outputs.reduce((max, c) => Math.max(max, c.price), 0);
  const existingCardIds = outputs.map((c) => c.card_id);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <ArrowUpCircle className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Upgrader</h1>
              <p className="text-sm text-muted-foreground">
                Manage the card pool the upgrader wheel pulls outputs from.
                Disabling a card hides it from the player&apos;s picker without
                removing it from the pool.
              </p>
            </div>
          </div>
          <AddUpgraderCardsDialog
            existingCardIds={existingCardIds}
            sets={filters.sets}
            rarities={filters.rarities}
          />
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Total in Pool"
          value={formatNumber(total)}
          icon={Layers}
          accent="blue"
        />
        <KpiTile
          label="Enabled"
          value={formatNumber(enabled)}
          icon={Sparkles}
          accent="emerald"
        />
        <KpiTile
          label="Disabled"
          value={formatNumber(disabled)}
          icon={EyeOff}
          accent="amber"
        />
        <KpiTile
          label="Avg. Price"
          value={formatCurrency(avgPrice)}
          sub={maxPrice > 0 ? `max ${formatCurrency(maxPrice)}` : undefined}
          icon={Coins}
          accent="purple"
        />
      </div>

      <FadeIn>
        <UpgraderOutputCardsGrid data={outputs} />
      </FadeIn>
    </div>
  );
}
