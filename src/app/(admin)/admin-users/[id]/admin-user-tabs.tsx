"use client";

import { Fragment, useState, useTransition, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  ChevronLeft,
  ChevronRight,
  LinkIcon,
  Search,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AdminRole } from "@/lib/dal";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { Switch } from "@/components/ui/switch";
import { ADMIN_PAGES } from "@/lib/admin-pages";
import { Trash2 } from "lucide-react";
import {
  toggleAdminActive,
  changeAdminRole,
  resetAdmin2FA,
} from "../actions";
import { setAdminLimit, deleteAdminLimit } from "../limits-actions";
import { forceExpireAllSessions, updateUserPermissions, searchMainSiteUsers, linkCreatorToMainUser } from "./actions";
import type { AdminUserDetail, AdminAuditStats } from "@/lib/queries/admin-users";
import type { PaginatedResult } from "@/lib/types";
import type { limit_period_type } from "@/generated/admin-prisma/client";

type AdminAuditEventItem = {
  id: string;
  eventType: string;
  targetUserId: string | null;
  targetUsername: string | null;
  ip: string | null;
  metadata: unknown;
  createdAt: string;
};

type BalanceLimit = {
  id: string;
  admin_user_id: string;
  period_type: limit_period_type;
  max_amount: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

type Props = {
  detail: AdminUserDetail;
  auditStats: AdminAuditStats;
  auditEvents: PaginatedResult<AdminAuditEventItem>;
  balanceLimits: BalanceLimit[];
  isCurrentUserAdmin: boolean;
};

export function AdminUserTabs({ detail, auditStats, auditEvents, balanceLimits, isCurrentUserAdmin }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function navigateParam(paramName: string, value: number | string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(paramName, String(value));
    if (paramName === "auditPerPage" || paramName === "auditEventType" || paramName === "auditSearch") {
      params.delete("auditPage");
    }
    router.push(`?${params.toString()}`, { scroll: false });
  }

  function clearParam(paramName: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(paramName);
    params.delete("auditPage");
    router.push(`?${params.toString()}`, { scroll: false });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <ProfileCard detail={detail} />
        <StatsCards auditStats={auditStats} />
        {isCurrentUserAdmin && (
          <BalanceLimitsCard adminUserId={detail.id} initialLimits={balanceLimits} />
        )}
      </div>
      <ManagementActions detail={detail} startTransition={startTransition} />
      {isCurrentUserAdmin && detail.role === "creator" && (
        <LinkMainUserCard detail={detail} />
      )}
      {isCurrentUserAdmin && detail.role !== "admin" && (
        <PermissionsSection detail={detail} />
      )}
      <AuditEventsTable
        auditEvents={auditEvents}
        activeEventType={searchParams.get("auditEventType") ?? "all"}
        activeSearch={searchParams.get("auditSearch") ?? ""}
        onPageChange={(p) => navigateParam("auditPage", p)}
        onPerPageChange={(pp) => navigateParam("auditPerPage", pp)}
        onEventTypeChange={(v) => v === "all" ? clearParam("auditEventType") : navigateParam("auditEventType", v)}
        onSearchChange={(v) => v ? navigateParam("auditSearch", v) : clearParam("auditSearch")}
      />
    </div>
  );
}

/* ── Profile Card ── */
function ProfileCard({ detail }: { detail: AdminUserDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Profile</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Row label="Email" value={detail.email} />
        <Row label="Username" value={detail.username} />
        <Row label="Role">
          <Badge variant="outline" className="text-xs uppercase">
            {detail.role}
          </Badge>
        </Row>
        <Row label="2FA">
          <Badge
            variant="outline"
            className={
              detail.totpEnabled
                ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                : "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30"
            }
          >
            {detail.totpEnabled ? "Enabled" : "Not set up"}
          </Badge>
        </Row>
        <Row label="Status">
          <Badge
            variant="outline"
            className={
              detail.isActive
                ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                : "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30"
            }
          >
            {detail.isActive ? "Active" : "Inactive"}
          </Badge>
        </Row>
        <Row label="Created" value={formatDateTime(detail.createdAt)} />
        {detail.role === "creator" && (
          <Row label="Linked User">
            {detail.linkedUser ? (
              <Link href={`/users/${detail.linkedUser.id}`} className="text-sm font-medium hover:underline">
                {detail.linkedUser.username ?? detail.linkedUser.id.slice(0, 8)}
              </Link>
            ) : (
              <span className="text-muted-foreground">Not linked</span>
            )}
          </Row>
        )}
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      {children ?? <span className="font-medium">{value}</span>}
    </div>
  );
}

/* ── Stats Cards ── */
function StatsCards({ auditStats }: { auditStats: AdminAuditStats }) {
  const topTypes = auditStats.eventsByType.slice(0, 5);
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row label="Total Actions" value={String(auditStats.totalActions)} />
          <Row
            label="Last Active"
            value={auditStats.lastActive ? formatRelative(auditStats.lastActive) : "Never"}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Top Event Types</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {topTypes.length === 0 && (
            <p className="text-muted-foreground">No events yet</p>
          )}
          {topTypes.map((e) => (
            <div key={e.eventType} className="flex justify-between">
              <span className="text-muted-foreground">{e.eventType}</span>
              <Badge variant="secondary">{e.count}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}

/* ── Balance Limits Card ── */
const PERIOD_TYPES: limit_period_type[] = ["daily", "weekly", "monthly"];
const PERIOD_LABELS: Record<limit_period_type, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

function BalanceLimitsCard({
  adminUserId,
  initialLimits,
}: {
  adminUserId: string;
  initialLimits: BalanceLimit[];
}) {
  const router = useRouter();
  const [limits, setLimits] = useState(initialLimits);
  const [isPending, startTransition] = useTransition();

  const limitMap = new Map(limits.map((l) => [l.period_type, l]));

  function handleSet(periodType: limit_period_type, value: string) {
    const amount = parseFloat(value);
    if (isNaN(amount) || amount <= 0) return;
    startTransition(async () => {
      try {
        await setAdminLimit({ adminUserId, periodType, maxAmount: amount });
        toast.success(`${PERIOD_LABELS[periodType]} limit set to $${amount.toFixed(2)}`);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to set limit");
      }
    });
  }

  function handleDelete(periodType: limit_period_type) {
    startTransition(async () => {
      try {
        await deleteAdminLimit(adminUserId, periodType);
        setLimits((prev) => prev.filter((l) => l.period_type !== periodType));
        toast.success(`${PERIOD_LABELS[periodType]} limit removed`);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to remove limit");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Adjust Balance Limit</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {PERIOD_TYPES.map((period) => {
          const existing = limitMap.get(period);
          return (
            <LimitRow
              key={period}
              label={PERIOD_LABELS[period]}
              currentAmount={existing ? Number(existing.max_amount) : null}
              disabled={isPending}
              onSet={(value) => handleSet(period, value)}
              onDelete={() => handleDelete(period)}
            />
          );
        })}
      </CardContent>
    </Card>
  );
}

function LimitRow({
  label,
  currentAmount,
  disabled,
  onSet,
  onDelete,
}: {
  label: string;
  currentAmount: number | null;
  disabled: boolean;
  onSet: (value: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentAmount != null ? String(currentAmount) : "");

  if (!editing && currentAmount != null) {
    return (
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1.5">
          <span
            className="text-sm font-medium cursor-pointer hover:underline"
            onClick={() => { setValue(String(currentAmount)); setEditing(true); }}
          >
            ${currentAmount.toFixed(2)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-destructive hover:text-destructive"
            disabled={disabled}
            onClick={onDelete}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
    );
  }

  if (!editing) {
    return (
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() => setEditing(true)}
        >
          Set limit
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <span className="text-sm text-muted-foreground">$</span>
        <Input
          type="number"
          className="h-7 w-24 text-sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          min={0}
          step={0.01}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onSet(value);
              setEditing(false);
            }
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={disabled || !value || parseFloat(value) <= 0}
          onClick={() => { onSet(value); setEditing(false); }}
        >
          Save
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setEditing(false)}
        >
          <X className="size-3" />
        </Button>
      </div>
    </div>
  );
}

/* ── Management Actions ── */
function ManagementActions({
  detail,
  startTransition,
}: {
  detail: AdminUserDetail;
  startTransition: React.TransitionStartFunction;
}) {
  const router = useRouter();

  function handleAction(action: () => Promise<void>, label: string) {
    startTransition(async () => {
      try {
        await action();
        toast.success(label);
        router.refresh();
      } catch {
        toast.error(`Failed: ${label}`);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Management</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <AlertDialog>
          <AlertDialogTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
            {detail.isActive ? "Deactivate" : "Activate"}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {detail.isActive ? "Deactivate" : "Activate"} {detail.username}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {detail.isActive
                  ? "This will prevent the admin from logging in."
                  : "This will allow the admin to log in again."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  handleAction(
                    () => toggleAdminActive(detail.id, !detail.isActive),
                    detail.isActive ? "Admin deactivated" : "Admin activated"
                  )
                }
              >
                Confirm
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <ChangeRoleDialog detail={detail} handleAction={handleAction} />

        {detail.totpEnabled && (
          <AlertDialog>
            <AlertDialogTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
              Reset 2FA
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset 2FA for {detail.username}?</AlertDialogTitle>
                <AlertDialogDescription>
                  They will need to set up 2FA again on next login.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    handleAction(() => resetAdmin2FA(detail.id), "2FA reset")
                  }
                >
                  Confirm
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        <AlertDialog>
          <AlertDialogTrigger className={buttonVariants({ variant: "destructive", size: "sm" })}>
            Expire All Sessions
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Force expire all sessions?</AlertDialogTitle>
              <AlertDialogDescription>
                All active sessions for {detail.username} will be invalidated.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  handleAction(
                    () => forceExpireAllSessions(detail.id),
                    "Sessions expired"
                  )
                }
              >
                Confirm
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

const ALL_ADMIN_ROLES: AdminRole[] = ["admin", "support", "marketing", "creator"];
const ROLE_LABELS: Record<AdminRole, string> = {
  admin: "Admin",
  support: "Support",
  marketing: "Marketing",
  creator: "Creator",
};

function ChangeRoleDialog({
  detail,
  handleAction,
}: {
  detail: AdminUserDetail;
  handleAction: (action: () => Promise<void>, label: string) => void;
}) {
  const [selectedRole, setSelectedRole] = useState<AdminRole | "">(
    ""
  );
  const [totpCode, setTotpCode] = useState("");
  const otherRoles = ALL_ADMIN_ROLES.filter((r) => r !== detail.role);

  return (
    <AlertDialog>
      <AlertDialogTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
        Change Role
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Change role for {detail.username}?</AlertDialogTitle>
          <AlertDialogDescription>
            Current role: <span className="font-medium uppercase">{detail.role}</span>.
            Select a new role below.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Select value={selectedRole} onValueChange={(v) => setSelectedRole(v as AdminRole)}>
          <SelectTrigger>
            <SelectValue placeholder="Select new role" />
          </SelectTrigger>
          <SelectContent>
            {otherRoles.map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">2FA Code</Label>
          <Input
            type="text"
            inputMode="numeric"
            placeholder="Enter your 6-digit code"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
            maxLength={6}
            autoComplete="one-time-code"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => { setTotpCode(""); setSelectedRole(""); }}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!selectedRole || !totpCode.trim()}
            onClick={() => {
              if (selectedRole && totpCode.trim()) {
                handleAction(
                  () => changeAdminRole(detail.id, selectedRole, totpCode.trim()),
                  "Role changed"
                );
                setTotpCode("");
              }
            }}
          >
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ── Link Main Site User (Creator only) ── */
function LinkMainUserCard({ detail }: { detail: AdminUserDetail }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; username: string | null; email: string | null; role: string }[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isPending, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 2) {
      setResults([]);
      return;
    }
    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const users = await searchMainSiteUsers(query);
        setResults(users);
      } catch {
        toast.error("Search failed");
      } finally {
        setIsSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function handleLink(mainUserId: string) {
    startTransition(async () => {
      try {
        await linkCreatorToMainUser(detail.id, mainUserId);
        toast.success("Creator linked to main site user");
        setResults([]);
        setQuery("");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to link");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Link to Main Site User</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Search for a main site user by username or email to link this creator account.
        </p>
        <Input
          placeholder="Search username or email..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {isSearching && <p className="text-sm text-muted-foreground">Searching...</p>}
        {results.length > 0 && (
          <div className="rounded-md border divide-y">
            {results.map((user) => (
              <div key={user.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <div>
                  <span className="font-medium">{user.username ?? user.email ?? user.id.slice(0, 8)}</span>
                  {user.username && user.email && (
                    <span className="text-muted-foreground ml-2">({user.email})</span>
                  )}
                  <Badge variant="outline" className="ml-2 text-xs">{user.role}</Badge>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => handleLink(user.id)}
                >
                  <LinkIcon className="size-3 mr-1" />
                  Link
                </Button>
              </div>
            ))}
          </div>
        )}
        {results.length === 0 && !isSearching && query.length >= 2 && (
          <p className="text-sm text-muted-foreground">No users found</p>
        )}
      </CardContent>
    </Card>
  );
}

/* ── Permissions Section ── */
function PermissionsSection({ detail }: { detail: AdminUserDetail }) {
  const [pages, setPages] = useState<string[]>(detail.allowedPages);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const groups = ADMIN_PAGES.reduce<Record<string, typeof ADMIN_PAGES>>((acc, page) => {
    (acc[page.group] ??= []).push(page);
    return acc;
  }, {});

  function toggle(key: string) {
    const next = pages.includes(key) ? pages.filter((p) => p !== key) : [...pages, key];
    setPages(next);
    save(next);
  }

  function toggleGroup(group: string) {
    const groupKeys = groups[group].map((p) => p.key);
    const allChecked = groupKeys.every((k) => pages.includes(k));
    const next = allChecked
      ? pages.filter((p) => !groupKeys.includes(p))
      : Array.from(new Set([...pages, ...groupKeys]));
    setPages(next);
    save(next);
  }

  function save(nextPages: string[]) {
    startTransition(async () => {
      try {
        await updateUserPermissions(detail.id, nextPages);
        router.refresh();
      } catch {
        toast.error("Failed to update permissions");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Permissions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 text-left text-sm font-medium">Page</th>
                <th className="px-4 py-2 text-center text-sm font-medium w-24">Access</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(groups).map(([group, groupPages]) => {
                const groupKeys = groupPages.map((p) => p.key);
                const allChecked = groupKeys.every((k) => pages.includes(k));
                return (
                  <Fragment key={group}>
                    <tr className="border-b bg-muted/30">
                      <td className="px-4 py-2 text-sm font-semibold">{group}</td>
                      <td className="px-4 py-2 text-center">
                        <Switch
                          size="sm"
                          checked={allChecked}
                          disabled={isPending}
                          onCheckedChange={() => toggleGroup(group)}
                        />
                      </td>
                    </tr>
                    {groupPages.map((page) => (
                      <tr key={page.key} className="border-b">
                        <td className="px-4 py-2 pl-8 text-sm text-muted-foreground">{page.label}</td>
                        <td className="px-4 py-2 text-center">
                          <Switch
                            size="sm"
                            checked={pages.includes(page.key)}
                            disabled={isPending}
                            onCheckedChange={() => toggle(page.key)}
                          />
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  admin_login: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  admin_user_created: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  admin_user_activated: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  admin_user_deactivated: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  admin_role_changed: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  admin_2fa_reset: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  admin_sessions_force_expired: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  balance_adjustment: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  account_banned: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  account_unbanned: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  account_locked: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  account_unlocked: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  role_changed: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  withdrawal_processed: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  withdrawal_shipped: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  withdrawal_completed: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  withdrawal_cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  withdrawal_failed: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  pack_activated: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  pack_deactivated: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  pack_update_approved: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  pack_update_rejected: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  card_update_approved: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  card_update_rejected: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  affiliate_payout_processed: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  promo_code_created: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  promo_code_deleted: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  rakeback_config_updated: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  race_prize_tier_updated: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  country_restriction_updated: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  chat_message_deleted: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  chat_message_pinned: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  chat_message_unpinned: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  chat_muted: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  chat_unmuted: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  admin_note_created: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  admin_note_deleted: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  admin_login: "Login",
  admin_user_created: "User Created",
  admin_user_activated: "Activated",
  admin_user_deactivated: "Deactivated",
  admin_role_changed: "Role Changed",
  admin_2fa_reset: "2FA Reset",
  admin_sessions_force_expired: "Sessions Expired",
  balance_adjustment: "Balance Adjust",
  account_banned: "Banned",
  account_unbanned: "Unbanned",
  account_locked: "Locked",
  account_unlocked: "Unlocked",
  role_changed: "Role Changed",
  withdrawal_processed: "WD Processed",
  withdrawal_shipped: "WD Shipped",
  withdrawal_completed: "WD Completed",
  withdrawal_cancelled: "WD Cancelled",
  withdrawal_failed: "WD Failed",
  pack_activated: "Pack Activated",
  pack_deactivated: "Pack Deactivated",
  pack_update_approved: "Pack Approved",
  pack_update_rejected: "Pack Rejected",
  card_update_approved: "Card Approved",
  card_update_rejected: "Card Rejected",
  affiliate_payout_processed: "Affiliate Payout",
  promo_code_created: "Promo Created",
  promo_code_deleted: "Promo Deleted",
  rakeback_config_updated: "Rakeback Updated",
  race_prize_tier_updated: "Race Prize Updated",
  country_restriction_updated: "Country Updated",
  chat_message_deleted: "Message Deleted",
  chat_message_pinned: "Message Pinned",
  chat_message_unpinned: "Message Unpinned",
  chat_muted: "User Muted",
  chat_unmuted: "User Unmuted",
  admin_note_created: "Note Added",
  admin_note_deleted: "Note Deleted",
};

function EventDetails({ event }: { event: AdminAuditEventItem }) {
  const meta = event.metadata as Record<string, unknown> | null;
  if (!meta) return <span className="text-muted-foreground">—</span>;

  const details: React.ReactNode[] = [];

  // Auth method
  if (meta.method) {
    details.push(
      <Badge key="method" variant="outline" className="text-xs">
        {String(meta.method)}
      </Badge>
    );
  }

  // Target admin user
  if (meta.target_admin_id) {
    details.push(
      <Link
        key="admin"
        href={`/admin-users/${meta.target_admin_id}`}
        className="text-blue-400 hover:underline text-xs"
      >
        Admin {String(meta.target_admin_id).slice(0, 8)}...
      </Link>
    );
  }

  // New role
  if (meta.new_role) {
    details.push(
      <Badge key="role" variant="outline" className="text-xs uppercase">
        {String(meta.new_role)}
      </Badge>
    );
  }

  // Created admin user info
  if (meta.username && meta.email) {
    details.push(
      <span key="created-user" className="text-xs">
        <span className="font-medium">{String(meta.username)}</span>
        <span className="text-muted-foreground"> ({String(meta.email)})</span>
      </span>
    );
  }
  if (meta.role && !meta.new_role && !meta.target_admin_id) {
    details.push(
      <Badge key="created-role" variant="outline" className="text-xs uppercase">
        {String(meta.role)}
      </Badge>
    );
  }

  // Balance adjustment
  if (meta.amount != null && event.eventType === "balance_adjustment") {
    const amt = Number(meta.amount);
    details.push(
      <span key="amount" className={`text-xs font-medium tabular-nums ${amt >= 0 ? "text-green-400" : "text-red-400"}`}>
        {amt >= 0 ? "+" : ""}{amt.toFixed(2)} USD
      </span>
    );
  }

  // Withdrawal link
  if (meta.withdrawal_id) {
    details.push(
      <Link
        key="withdrawal"
        href={`/withdrawals/${meta.withdrawal_id}`}
        className="text-blue-400 hover:underline text-xs font-mono"
      >
        {String(meta.withdrawal_id).slice(0, 8)}...
      </Link>
    );
  }

  // Withdrawal shipping details
  if (meta.tracking_number) {
    details.push(
      <span key="tracking" className="text-xs text-muted-foreground">
        Tracking: {String(meta.tracking_number)}
      </span>
    );
  }
  if (meta.carrier) {
    details.push(
      <Badge key="carrier" variant="outline" className="text-xs">
        {String(meta.carrier)}
      </Badge>
    );
  }

  // Pack link
  if (meta.pack_id) {
    details.push(
      <Link
        key="pack"
        href={`/packs/${meta.pack_id}`}
        className="text-blue-400 hover:underline text-xs font-mono"
      >
        Pack {String(meta.pack_id).slice(0, 8)}...
      </Link>
    );
  }

  // Promo code
  if (meta.value != null && event.eventType === "promo_code_created") {
    details.push(
      <span key="promo-value" className="text-xs font-medium">
        ${Number(meta.value).toFixed(2)}
      </span>
    );
    if (meta.region) {
      details.push(
        <Badge key="promo-region" variant="outline" className="text-xs">
          {String(meta.region)}
        </Badge>
      );
    }
  }

  // Affiliate payout
  if (meta.amount != null && event.eventType === "affiliate_payout_processed") {
    details.push(
      <span key="payout-amount" className="text-xs font-medium text-green-400">
        ${Number(meta.amount).toFixed(2)}
      </span>
    );
  }

  // Feature lock toggle
  if (meta.feature) {
    details.push(
      <Badge key="feature" variant="outline" className="text-xs">
        {String(meta.feature).replace(/_/g, " ")}
      </Badge>
    );
  }

  // Chat message
  if (meta.message_id) {
    details.push(
      <Link
        key="msg"
        href={`/chat?highlight=${meta.message_id}`}
        className="text-blue-400 hover:underline text-xs font-mono"
      >
        Message {String(meta.message_id).slice(0, 8)}...
      </Link>
    );
  }

  // Reason (ban, lock, mute, cancel, fail)
  if (meta.reason) {
    details.push(
      <span key="reason" className="text-xs text-muted-foreground">
        Reason: {String(meta.reason)}
      </span>
    );
  }

  // Note preview
  if (meta.content_preview) {
    details.push(
      <span key="note" className="text-xs text-muted-foreground italic truncate max-w-[200px] inline-block align-bottom">
        &ldquo;{String(meta.content_preview)}&rdquo;
      </span>
    );
  }

  if (details.length === 0) return <span className="text-muted-foreground">—</span>;

  return <div className="flex flex-wrap items-center gap-1.5">{details}</div>;
}

/* ── Audit Events Table ── */
function AuditEventsTable({
  auditEvents,
  activeEventType,
  activeSearch,
  onPageChange,
  onPerPageChange,
  onEventTypeChange,
  onSearchChange,
}: {
  auditEvents: PaginatedResult<AdminAuditEventItem>;
  activeEventType: string;
  activeSearch: string;
  onPageChange: (page: number) => void;
  onPerPageChange: (perPage: number) => void;
  onEventTypeChange: (value: string) => void;
  onSearchChange: (value: string) => void;
}) {
  const [searchInput, setSearchInput] = useState(activeSearch);
  const hasFilters = activeEventType !== "all" || activeSearch !== "";

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSearchChange(searchInput);
  }

  function clearFilters() {
    setSearchInput("");
    onEventTypeChange("all");
    onSearchChange("");
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Audit Events</h2>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Rows per page</span>
          <Select
            value={String(auditEvents.perPage)}
            onValueChange={(v) => onPerPageChange(Number(v))}
          >
            <SelectTrigger className="h-8 w-[70px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 20, 50, 100].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Event Type</Label>
          <Select value={activeEventType} onValueChange={(v) => v && onEventTypeChange(v)}>
            <SelectTrigger className="h-9 w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Target User</Label>
          <form onSubmit={handleSearchSubmit} className="flex items-center gap-1">
            <div className="relative">
              <Input
                className="h-9 w-[280px] text-xs pr-8"
                placeholder="Username or user ID..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              <button type="submit" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <Search className="size-3" />
              </button>
            </div>
          </form>
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-8 mt-5" onClick={clearFilters}>
            <X className="size-3" />
          </Button>
        )}
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Target User</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {auditEvents.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                  No audit events
                </TableCell>
              </TableRow>
            )}
            {auditEvents.data.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-sm whitespace-nowrap">
                  {formatDateTime(e.createdAt)}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={`text-xs ${EVENT_TYPE_COLORS[e.eventType] ?? "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"}`}
                  >
                    {EVENT_TYPE_LABELS[e.eventType] ?? e.eventType}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm">
                  {e.targetUserId ? (
                    <Link
                      href={`/users/${e.targetUserId}`}
                      className="text-blue-400 hover:underline"
                    >
                      {e.targetUsername ?? e.targetUserId.slice(0, 8)}
                    </Link>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  <EventDetails event={e} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {auditEvents.total} total event{auditEvents.total !== 1 ? "s" : ""}
        </span>
        <Pagination
          page={auditEvents.page}
          totalPages={auditEvents.totalPages}
          onPageChange={onPageChange}
        />
      </div>
    </>
  );
}

/* ── Pagination ── */
function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2">
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <span className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
