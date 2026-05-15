import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatedNumber, type AnimatedNumberFormat } from "@/components/animated-number";

const colorMap = {
  blue: { bg: "bg-blue-500/10", icon: "text-blue-400" },
  // `emerald` is the house-POV "house gain" accent used for deposits, wagers,
  // positive P&L/GGR. `green` is kept as an alias so existing call sites
  // don't have to be touched at once.
  emerald: { bg: "bg-emerald-500/10", icon: "text-emerald-400" },
  green: { bg: "bg-emerald-500/10", icon: "text-emerald-400" },
  // `rose` is the "house loss" accent — withdrawals, payouts to users,
  // creator commission, negative P&L.
  rose: { bg: "bg-rose-500/10", icon: "text-rose-400" },
  purple: { bg: "bg-purple-500/10", icon: "text-purple-400" },
  orange: { bg: "bg-orange-500/10", icon: "text-orange-400" },
  pink: { bg: "bg-pink-500/10", icon: "text-pink-400" },
  cyan: { bg: "bg-cyan-500/10", icon: "text-cyan-400" },
  amber: { bg: "bg-amber-500/10", icon: "text-amber-400" },
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
  const colors = color ? colorMap[color] : null;
  const useAnimated =
    typeof animatedValue === "number" && typeof formatKind === "string";

  return (
    <Card className={cn(colors?.bg)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="truncate text-card-title text-muted-foreground">
          {title}
        </CardTitle>
        <Icon
          className={cn(
            "size-4 shrink-0",
            colors?.icon ?? "text-muted-foreground",
          )}
        />
      </CardHeader>
      <CardContent>
        <div className="truncate text-stat-value">
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
