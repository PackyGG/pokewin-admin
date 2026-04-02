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
import { formatRelative, formatCurrency } from "@/lib/utils/format";
import type { AuditListItem } from "@/lib/queries/audit";

const EVENT_COLORS: Record<string, string> = {
  admin_login: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  account_banned: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  account_unbanned: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  account_locked: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  account_unlocked: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  balance_adjustment: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  role_changed: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  pack_activated: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  pack_deactivated: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  withdrawal_processed: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  withdrawal_shipped: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  withdrawal_completed: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  withdrawal_cancelled: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  withdrawal_failed: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  chat_message_deleted: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  chat_message_pinned: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  chat_message_unpinned: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  chat_muted: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  chat_unmuted: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  admin_user_created: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  promo_code_created: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
};

function MetadataCell({
  eventType,
  metadata,
  messageContent,
  messageDeleted,
  promoCodeId,
}: {
  eventType: string;
  metadata: unknown;
  messageContent: string | null;
  messageDeleted: boolean | null;
  promoCodeId: string | null;
}) {
  if (!metadata || typeof metadata !== "object")
    return <span className="text-muted-foreground">-</span>;
  const m = metadata as Record<string, unknown>;

  const items: React.ReactNode[] = [];

  if (m.withdrawal_id) {
    items.push(
      <Link
        key="wd"
        href={`/withdrawals/${m.withdrawal_id}`}
        className="text-blue-400 hover:underline font-mono text-xs"
      >
        {(m.withdrawal_id as string).slice(0, 8)}...
      </Link>
    );
  }
  if (m.message_id && messageContent) {
    items.push(
      <span
        key="msg"
        className={`text-xs italic max-w-[300px] truncate ${messageDeleted ? "line-through text-muted-foreground" : ""}`}
        title={messageContent}
      >
        &ldquo;{messageContent}&rdquo;
      </span>
    );
  } else if (m.message_id) {
    items.push(
      <span key="msg" className="font-mono text-xs text-muted-foreground">
        msg:{(m.message_id as string).slice(0, 8)}
      </span>
    );
  }
  if (m.pack_id) {
    items.push(
      <Link
        key="pack"
        href={`/packs/${m.pack_id}`}
        className="text-blue-400 hover:underline font-mono text-xs"
      >
        pack:{(m.pack_id as string).slice(0, 8)}
      </Link>
    );
  }

  if (m.method) {
    items.push(
      <Badge key="method" variant="outline" className="text-[10px] px-1.5 py-0">
        {m.method as string}
      </Badge>
    );
  }
  if (m.action) {
    items.push(
      <Badge key="action" variant="outline" className="text-[10px] px-1.5 py-0">
        {m.action as string}
      </Badge>
    );
  }
  if (m.new_role) {
    items.push(
      <Badge
        key="role"
        variant="outline"
        className="text-[10px] px-1.5 py-0 bg-purple-500/15 text-purple-600 dark:text-purple-400"
      >
        {m.new_role as string}
      </Badge>
    );
  }
  if (m.role) {
    items.push(
      <Badge
        key="role2"
        variant="outline"
        className="text-[10px] px-1.5 py-0 bg-purple-500/15 text-purple-600 dark:text-purple-400"
      >
        {m.role as string}
      </Badge>
    );
  }
  if (m.feature) {
    items.push(
      <Badge key="feat" variant="outline" className="text-[10px] px-1.5 py-0">
        {(m.feature as string).replace(/_/g, " ")}
      </Badge>
    );
  }
  if (m.locked != null) {
    items.push(
      <Badge
        key="lock"
        variant="outline"
        className={`text-[10px] px-1.5 py-0 ${m.locked ? "bg-red-500/15 text-red-600 dark:text-red-400" : "bg-green-500/15 text-green-600 dark:text-green-400"}`}
      >
        {m.locked ? "locked" : "unlocked"}
      </Badge>
    );
  }

  if (m.amount != null) {
    const amt = Number(m.amount);
    items.push(
      <span
        key="amt"
        className={`text-xs font-medium ${amt >= 0 ? "text-green-400" : "text-red-400"}`}
      >
        {amt >= 0 ? "+" : ""}
        {formatCurrency(amt)}
      </span>
    );
  }
  if (m.amount_usd != null) {
    items.push(
      <span key="amtusd" className="text-xs font-medium text-green-400">
        {formatCurrency(Number(m.amount_usd))}
      </span>
    );
  }

  if (m.reason) {
    items.push(
      <span
        key="reason"
        className="text-xs text-muted-foreground truncate max-w-[200px]"
      >
        &ldquo;{m.reason as string}&rdquo;
      </span>
    );
  }
  if (m.carrier) {
    items.push(
      <span key="carrier" className="text-xs text-muted-foreground">
        {m.carrier as string}
      </span>
    );
  }
  if (m.tracking_number) {
    items.push(
      <span key="track" className="font-mono text-xs text-muted-foreground">
        {m.tracking_number as string}
      </span>
    );
  }
  if (m.email && eventType.includes("admin_user")) {
    items.push(
      <span key="email" className="text-xs text-muted-foreground">
        {m.email as string}
      </span>
    );
  }
  if (m.username && eventType.includes("admin_user")) {
    items.push(
      <span key="uname" className="text-xs font-medium">
        {m.username as string}
      </span>
    );
  }
  if (m.code_hash) {
    if (promoCodeId) {
      items.push(
        <Link
          key="code"
          href={`/promo-codes/${promoCodeId}`}
          className="text-blue-400 hover:underline font-mono text-xs"
        >
          code:{(m.code_hash as string).slice(0, 8)}
        </Link>
      );
    } else {
      items.push(
        <span key="code" className="font-mono text-xs text-muted-foreground">
          code:{(m.code_hash as string).slice(0, 8)}
        </span>
      );
    }
  }
  if (m.region) {
    items.push(
      <Badge key="region" variant="outline" className="text-[10px] px-1.5 py-0">
        {m.region as string}
      </Badge>
    );
  }
  if (m.value != null && !m.amount && eventType.includes("promo")) {
    items.push(
      <span key="val" className="text-xs font-medium text-green-400">
        {formatCurrency(Number(m.value))}
      </span>
    );
  }

  // Generic ID links
  if (m.battle_id) {
    items.push(
      <Link key="battle" href={`/battles/${m.battle_id}`} className="text-blue-400 hover:underline font-mono text-xs">
        battle:{(m.battle_id as string).slice(0, 8)}
      </Link>
    );
  }
  if (m.raffle_id) {
    items.push(
      <Link key="raffle" href={`/rewards/raffles/${m.raffle_id}`} className="text-blue-400 hover:underline font-mono text-xs">
        raffle:{(m.raffle_id as string).slice(0, 8)}
      </Link>
    );
  }
  if (m.reward_id) {
    items.push(
      <Link key="reward" href={`/rewards/${m.reward_id}`} className="text-blue-400 hover:underline font-mono text-xs">
        reward:{(m.reward_id as string).slice(0, 8)}
      </Link>
    );
  }

  // Generic descriptive fields
  if (m.name) {
    items.push(
      <span key="name" className="text-xs font-medium">
        {m.name as string}
      </span>
    );
  }
  if (m.slug) {
    items.push(
      <Badge key="slug" variant="outline" className="text-[10px] px-1.5 py-0">
        {m.slug as string}
      </Badge>
    );
  }
  if (m.type) {
    items.push(
      <Badge key="type" variant="outline" className="text-[10px] px-1.5 py-0">
        {m.type as string}
      </Badge>
    );
  }

  // Site config: field + value
  if (m.field) {
    items.push(
      <span key="field" className="text-xs font-medium">
        {(m.field as string).replace(/_/g, " ")}
      </span>
    );
    if (m.value != null && !eventType.includes("promo")) {
      items.push(
        <Badge
          key="cfgval"
          variant="outline"
          className={`text-[10px] px-1.5 py-0 ${m.value === true ? "bg-green-500/15 text-green-600 dark:text-green-400" : m.value === false ? "bg-red-500/15 text-red-600 dark:text-red-400" : ""}`}
        >
          {String(m.value)}
        </Badge>
      );
    }
  }

  // Catch remaining unhandled keys as key:value pairs
  if (items.length === 0) {
    const handled = new Set([
      "withdrawal_id", "message_id", "pack_id", "method", "action",
      "new_role", "role", "feature", "locked", "amount", "amount_usd",
      "reason", "carrier", "tracking_number", "email", "username",
      "code_hash", "region", "value", "battle_id", "raffle_id",
      "reward_id", "name", "slug", "type", "field",
    ]);
    const remaining = Object.entries(m).filter(([k]) => !handled.has(k));
    if (remaining.length > 0) {
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          {remaining.map(([k, v]) => (
            <span key={k} className="font-mono text-xs text-muted-foreground">
              {k}:{typeof v === "string" && v.length > 16 ? v.slice(0, 16) + "…" : String(v)}
            </span>
          ))}
        </div>
      );
    }
  }

  return <div className="flex flex-wrap items-center gap-1.5">{items}</div>;
}

export function AuditActivityTable({ data }: { data: AuditListItem[] }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Event</TableHead>
            <TableHead>Admin</TableHead>
            <TableHead>Target User</TableHead>
            <TableHead>IP</TableHead>
            <TableHead>Details</TableHead>
            <TableHead>Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <Badge
                  variant="outline"
                  className={
                    EVENT_COLORS[item.eventType] ??
                    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                  }
                >
                  {item.eventType.replace(/_/g, " ")}
                </Badge>
              </TableCell>
              <TableCell className="text-sm font-medium">
                {item.adminUserId ? (
                  <Link
                    href={`/admin-users/${item.adminUserId}`}
                    className="text-blue-400 hover:underline"
                  >
                    {item.adminUsername ?? item.adminUserId.slice(0, 8)}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell className="text-sm">
                {item.targetUserId ? (
                  <Link
                    href={`/users/${item.targetUserId}`}
                    className="text-blue-400 hover:underline"
                  >
                    {item.targetUsername ?? item.targetUserId.slice(0, 8)}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs">{item.ip ?? "-"}</span>
              </TableCell>
              <TableCell>
                <MetadataCell
                  eventType={item.eventType}
                  metadata={item.metadata}
                  messageContent={item.messageContent}
                  messageDeleted={item.messageDeleted}
                  promoCodeId={item.promoCodeId}
                />
              </TableCell>
              <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                {formatRelative(item.createdAt)}
              </TableCell>
            </TableRow>
          ))}
          {data.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="h-24 text-center">
                No audit events found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
