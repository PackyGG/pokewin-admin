import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatedNumber, type AnimatedNumberFormat } from "@/components/animated-number";

// Flat direction (matches the shared modern-panels flatten): the card is a
// solid neutral `bg-card` surface carrying the Card primitive's hairline
// ring — the per-hue colored FILL was the layered tint the flat pilot drops.
// The accent now survives ONLY on the icon glyph, never the card background.
// `emerald`/`green` are the house-POV "house gain" accent (deposits, wagers,
// positive P&L/GGR); `rose` is the "house loss" accent (withdrawals, payouts
// to users, creator commission, negative P&L). `green` stays as an alias for
// `emerald` so existing call sites don't have to be touched at once.
const colorMap = {
  blue: "text-blue-400",
  emerald: "text-emerald-400",
  green: "text-emerald-400",
  rose: "text-rose-400",
  purple: "text-purple-400",
  orange: "text-orange-400",
  pink: "text-pink-400",
  cyan: "text-cyan-400",
  amber: "text-amber-400",
} as const;

export type StatCardColor = keyof typeof colorMap;

/**
 * Pass `value` for a plain rendered string, OR `animatedValue` + `formatKind`
 * to get a smooth transition on value changes. `formatKind` is a serializable
 * string enum so the component works across the RSC boundary — passing a
 * function formatter would crash Server Component rendering.
 */
export function StatCard({
  title,
  value,
  animatedValue,
  formatKind,
  subtitle,
  icon: Icon,
  color,
  children,
}: {
  title: string;
  value?: string | number;
  animatedValue?: number;
  formatKind?: AnimatedNumberFormat;
  subtitle?: string;
  icon: LucideIcon;
  color?: StatCardColor;
  children?: React.ReactNode;
}) {
  const iconColor = color ? colorMap[color] : null;
  const useAnimated =
    typeof animatedValue === "number" && typeof formatKind === "string";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="truncate text-card-title text-muted-foreground">
          {title}
        </CardTitle>
        <Icon
          className={cn(
            "size-4 shrink-0",
            iconColor ?? "text-muted-foreground",
          )}
        />
      </CardHeader>
      <CardContent>
        <div className="truncate text-stat-value tabular-nums">
          {useAnimated ? (
            <AnimatedNumber value={animatedValue!} format={formatKind!} />
          ) : (
            value
          )}
        </div>
        {subtitle && <p className="text-stat-label">{subtitle}</p>}
        {children}
      </CardContent>
    </Card>
  );
}
