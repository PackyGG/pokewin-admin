"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Card, CardContent } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils/format";
import type { BattleModeStats, PackPopularityStats } from "@/lib/queries/analytics";

function SectionShell({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors">
        <ChevronDown
          className={`size-4 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function StatRow({
  label,
  count,
  total,
}: {
  label: string;
  count: number;
  total: number;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="capitalize text-foreground">{label.replace(/_/g, " ")}</span>
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground tabular-nums">
          {pct.toFixed(1)}%
        </span>
        <span className="font-medium tabular-nums w-16 text-right">
          {formatNumber(count)}
        </span>
      </div>
    </div>
  );
}

export function BattleModesSection({ stats }: { stats: BattleModeStats }) {
  const total = stats.totalBattles;
  const totalBattlePackOpens = stats.topBattlePacks.reduce(
    (a, p) => a + p.count,
    0,
  );
  return (
    <SectionShell title={`Battles (${formatNumber(total)} total)`}>
      <Card>
        <CardContent className="grid gap-6 p-4 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
              By Mode
            </h4>
            {stats.byMode.length === 0 && (
              <p className="text-xs text-muted-foreground">No data</p>
            )}
            {stats.byMode.map((m) => (
              <StatRow key={m.mode} label={m.mode} count={m.count} total={total} />
            ))}
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
              Format
            </h4>
            {stats.byFormat.length === 0 && (
              <p className="text-xs text-muted-foreground">No data</p>
            )}
            {stats.byFormat.map((f) => (
              <StatRow
                key={f.format}
                label={f.format}
                count={f.count}
                total={total}
              />
            ))}
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
              Settings
            </h4>
            {stats.bySetting.length === 0 && (
              <p className="text-xs text-muted-foreground">No data</p>
            )}
            {stats.bySetting.map((s) => (
              <StatRow
                key={s.setting}
                label={s.setting}
                count={s.count}
                total={total}
              />
            ))}
            <div className="mt-3 border-t pt-2">
              <StatRow label="borrow" count={stats.borrowCount} total={total} />
              <StatRow
                label="sponsored"
                count={stats.sponsoredCount}
                total={total}
              />
              <StatRow label="private" count={stats.privateCount} total={total} />
            </div>
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
              Top Battle Packs
            </h4>
            {stats.topBattlePacks.length === 0 && (
              <p className="text-xs text-muted-foreground">No data</p>
            )}
            {stats.topBattlePacks.map((p) => (
              <StatRow
                key={p.id}
                label={p.name}
                count={p.count}
                total={totalBattlePackOpens}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </SectionShell>
  );
}

export function PackPopularitySection({ stats }: { stats: PackPopularityStats }) {
  const totalOpens = stats.topPacks.reduce((acc, p) => acc + p.opensTotal, 0);
  const totalBorrowed = stats.topBorrowedPacks.reduce(
    (acc, p) => acc + p.opensBorrowed,
    0,
  );
  return (
    <SectionShell title={`Packs — Solo Openings (${formatNumber(totalOpens)} total)`}>
      <Card>
        <CardContent className="grid gap-6 p-4 md:grid-cols-2">
          <div>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
              Most Popular
            </h4>
            {stats.topPacks.length === 0 && (
              <p className="text-xs text-muted-foreground">No data</p>
            )}
            {stats.topPacks.map((p) => (
              <StatRow
                key={p.id}
                label={p.name}
                count={p.opensTotal}
                total={totalOpens}
              />
            ))}
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
              Most Popular with Borrow
            </h4>
            {stats.topBorrowedPacks.length === 0 && (
              <p className="text-xs text-muted-foreground">No borrowed opens</p>
            )}
            {stats.topBorrowedPacks.map((p) => (
              <StatRow
                key={p.id}
                label={p.name}
                count={p.opensBorrowed}
                total={totalBorrowed}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </SectionShell>
  );
}
