import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";
import { Globe } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils/format";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";

// Register once per module load. Safe to call repeatedly — the lib dedupes.
countries.registerLocale(enLocale);

type CountryRow = { country: string; clicks: number; signups: number };

// Convert a full country name from the geolocation service into a flag
// emoji via ISO alpha-2 lookup. Falls back to a globe if the name can't
// be resolved (e.g. "unknown" rows, or niche names the lib doesn't index).
const flagFor = (countryName: string): string => {
  const alpha2 = countries.getAlpha2Code(countryName, "en");
  if (!alpha2 || alpha2.length !== 2) return "🌐";
  const codePoints = [...alpha2.toUpperCase()].map(
    (c) => 127397 + c.charCodeAt(0),
  );
  return String.fromCodePoint(...codePoints);
};

export function CountryBreakdown({ rows }: { rows: CountryRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-card-title">Top countries</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Clicks + signups by country
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          <EmptyState
            icon={Globe}
            title="No geographic data yet"
            description="Country-level clicks and signups appear once the code starts getting traffic."
            compact
          />
        </CardContent>
      </Card>
    );
  }

  const totalClicks = rows.reduce((sum, r) => sum + r.clicks, 0);
  const totalSignups = rows.reduce((sum, r) => sum + r.signups, 0);
  const maxCombined = Math.max(
    ...rows.map((r) => r.clicks + r.signups),
    1,
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-card-title">Top countries</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatNumber(totalClicks)} clicks · {formatNumber(totalSignups)} signups across{" "}
          {rows.length} countries
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="divide-y divide-border/60">
          {rows.slice(0, 10).map((r) => {
            const total = r.clicks + r.signups;
            const clickPct = total > 0 ? (r.clicks / total) * 100 : 0;
            const signupPct = total > 0 ? (r.signups / total) * 100 : 0;
            const width = (total / maxCombined) * 100;
            return (
              <li
                key={r.country}
                className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <span className="text-lg leading-none" aria-hidden>
                  {flagFor(r.country)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium">
                      {r.country}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatNumber(r.clicks)} clicks ·{" "}
                      <span className="text-foreground font-medium">
                        {formatNumber(r.signups)} signups
                      </span>
                    </span>
                  </div>
                  <div
                    className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                    style={{ maxWidth: `${Math.max(width, 4)}%` }}
                  >
                    {/* Stacked: clicks (chart-1) | signups (chart-4) */}
                    <div
                      className={cn("absolute inset-y-0 left-0 bg-[var(--chart-1)]")}
                      style={{ width: `${clickPct}%` }}
                    />
                    <div
                      className="absolute inset-y-0 bg-[var(--chart-4)]"
                      style={{ left: `${clickPct}%`, width: `${signupPct}%` }}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {rows.length > 10 ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            + {rows.length - 10} more
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
