import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const colorMap = {
  blue: { bg: "bg-blue-500/10", icon: "text-blue-400" },
  green: { bg: "bg-emerald-500/10", icon: "text-emerald-400" },
  purple: { bg: "bg-purple-500/10", icon: "text-purple-400" },
  orange: { bg: "bg-orange-500/10", icon: "text-orange-400" },
  pink: { bg: "bg-pink-500/10", icon: "text-pink-400" },
  cyan: { bg: "bg-cyan-500/10", icon: "text-cyan-400" },
} as const;

export type StatCardColor = keyof typeof colorMap;

export function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  color,
  children,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  color?: StatCardColor;
  children?: React.ReactNode;
}) {
  const colors = color ? colorMap[color] : null;

  return (
    <Card className={cn(colors?.bg)}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-card-title text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className={cn("size-4", colors?.icon ?? "text-muted-foreground")} />
      </CardHeader>
      <CardContent>
        <div className="text-stat-value">{value}</div>
        {subtitle && (
          <p className="text-stat-label">{subtitle}</p>
        )}
        {children}
      </CardContent>
    </Card>
  );
}
