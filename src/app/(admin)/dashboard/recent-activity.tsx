import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelative, formatCurrency } from "@/lib/utils/format";
import type { ActivityItem } from "@/lib/queries/dashboard";

function getActivityHref(item: ActivityItem): string {
  if (item.source === "transaction") return `/transactions/${item.id}`;
  if (item.source === "audit" && item.adminUserId) return `/admin-users/${item.adminUserId}`;
  return "/audit";
}

const typeBadgeColors: Record<string, string> = {
  deposit: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  card_sale: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20",
  pack_opening: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20",
  battle_bet: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20",
  battle_sponsorship: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20",
};

function getBadgeClass(item: ActivityItem) {
  if (item.source === "audit") return "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/20";
  return typeBadgeColors[item.type] ?? "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/20";
}

export function RecentActivity({ items }: { items: ActivityItem[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Recent Activity</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Detail</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={`${item.source}-${item.id}`} className="cursor-pointer hover:bg-muted/50">
                <TableCell>
                  <Link href={getActivityHref(item)} className="contents">
                    <Badge
                      variant="outline"
                      className={`font-mono text-xs ${getBadgeClass(item)}`}
                    >
                      {item.type}
                    </Badge>
                  </Link>
                </TableCell>
                <TableCell className="text-sm">
                  {item.userId ? (
                    <Link
                      href={`/users/${item.userId}`}
                      className="text-blue-400 hover:underline"
                    >
                      {item.username}
                    </Link>
                  ) : (
                    <span>{item.username}</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  {item.targetUserId ? (
                    <Link
                      href={`/users/${item.targetUserId}`}
                      className="text-blue-400 hover:underline"
                                          >
                      {item.targetUsername ?? "Unknown"}
                    </Link>
                  ) : item.userId ? (
                    <Link
                      href={`/users/${item.userId}`}
                      className="text-blue-400 hover:underline"
                                          >
                      {item.targetUsername ?? "Unknown"}
                    </Link>
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">
                  <Link href={getActivityHref(item)} className="contents">
                    {item.detail ?? "-"}
                  </Link>
                </TableCell>
                <TableCell className="text-sm">
                  <Link href={getActivityHref(item)} className="contents">
                    {item.amount != null ? formatCurrency(item.amount) : "-"}
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  <Link href={getActivityHref(item)} className="contents">
                    {formatRelative(item.createdAt)}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No recent activity
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
