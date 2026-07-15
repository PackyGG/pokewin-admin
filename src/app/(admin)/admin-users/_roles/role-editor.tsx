"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Save,
  Trash2,
  ShieldCheck,
  Lock,
  KeyRound,
  SlidersHorizontal,
  Plus,
  Minus,
  RefreshCw,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StepUpField } from "@/components/step-up-field";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ux";
import {
  ALL_PERMISSION_KEYS,
  CAPABILITIES,
} from "@/app/(admin)/settings/roles/permissions-utils";
import { describeToken } from "@/app/(admin)/admin-users/_components/token-describe";
import { PermissionPicker } from "@/app/(admin)/admin-users/_components/permission-picker";
import { formatCurrency } from "@/lib/utils/format";
import { ADMIN_PAGES } from "@/lib/admin-pages";
import type { RoleEditorData } from "./role-editor-data";
import { updateRole, deleteRole } from "./custom-roles-actions";
import { updateBuiltInRole } from "./built-in-roles-actions";
import { setRoleLimits } from "@/lib/role-limits-actions";

// Sentinel for the landing-route Select's "no override" option (base-ui Select
// can't use an empty-string value cleanly). Maps to "" (→ today's routing).
const LANDING_DEFAULT = "__default__";

// ADMIN_PAGES grouped by their nav section, in first-seen order, for the
// landing-route Select. Plain data — no DB, computed once at module load.
const LANDING_PAGE_GROUPS: { group: string; pages: { key: string; label: string }[] }[] =
  (() => {
    const order: string[] = [];
    const byGroup = new Map<string, { key: string; label: string }[]>();
    for (const p of ADMIN_PAGES) {
      if (!byGroup.has(p.group)) {
        byGroup.set(p.group, []);
        order.push(p.group);
      }
      byGroup.get(p.group)!.push({ key: p.key, label: p.label });
    }
    return order.map((group) => ({ group, pages: byGroup.get(group)! }));
  })();

/* ── Per-role editor (RoleV2 P4) ──
 *
 * One editor for EVERY `admin_roles` row — built-in (system) OR custom — minus
 * the `admin` total-bypass role, which renders read-only (its caps are ignored
 * by the gate). Branches on `data.systemKey`:
 *   • Identity   — name disabled for system rows, editable for custom; the
 *                  description is editable on both.
 *   • Pages      — every page key as a Switch, grouped by nav-section.
 *   • Capabilities — every `__can_*` as a Switch, grouped by capability group.
 *   • Limits     — balance-adjustment Daily/Weekly/Monthly USD inputs (empty =
 *                  no role default). Issuance inputs render but are marked
 *                  "schema ready · enforcement pending".
 *
 * Save opens a preview-DIFF dialog (caps added/removed, limits old→new, the
 * count of users that will be re-materialized) requiring a 2FA code. On confirm
 * it calls `updateBuiltInRole` (system) or `updateRole` (custom) for the
 * capabilities + description, AND `setRoleLimits` for any changed limit. No
 * function props cross the server→client boundary: the page passes a plain
 * serializable `RoleEditorData`.
 */

type LimitPeriods = { daily: string; weekly: string; monthly: string };
type LimitsForm = { balanceAdjustment: LimitPeriods; issuance: LimitPeriods };

// Everything in the capability catalog is enforced today, so there is no honest
// "dead" set to badge — kept as an explicit (empty) constant so the prop is
// wired and a future dead capability only needs adding here. (Issuance LIMITS,
// by contrast, are genuinely not enforced yet and are labelled inline below.)
const DEAD_CAPABILITY_KEYS: ReadonlySet<string> = new Set<string>();

function numToInput(v: number | null): string {
  return v === null || v === undefined ? "" : String(v);
}

function toLimitsForm(data: RoleEditorData): LimitsForm {
  const ba = data.limits.balanceAdjustment;
  const iss = data.limits.issuance ?? { daily: null, weekly: null, monthly: null };
  return {
    balanceAdjustment: {
      daily: numToInput(ba.daily),
      weekly: numToInput(ba.weekly),
      monthly: numToInput(ba.monthly),
    },
    issuance: {
      daily: numToInput(iss.daily),
      weekly: numToInput(iss.weekly),
      monthly: numToInput(iss.monthly),
    },
  };
}

/**
 * Parse a limit input to the value the action expects: a positive number, or
 * `null` for an empty field (clear the cap). Returns `undefined` for an invalid
 * entry (non-numeric / ≤ 0) so the caller can reject the save.
 */
function parseLimitInput(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

export function RoleEditor({ data }: { data: RoleEditorData }) {
  // `admin` (or any bypass row) is read-only — its caps don't gate anything.
  if (data.bypass) return <AdminBypassView data={data} />;
  return <EditableRoleEditor data={data} />;
}

/** Read-only view for the `admin` total-bypass role. No toggles. */
function AdminBypassView({ data }: { data: RoleEditorData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-emerald-500" />
          {data.name}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              Admin bypasses every page and capability check — its access
              can&apos;t be restricted here.
            </p>
            <p className="text-muted-foreground">
              The gate short-circuits for the{" "}
              <span className="font-medium">admin</span> role before consulting
              any page list or capability flag, so editing its tokens or limits
              would have no effect. To scope what a person can do, give them a
              non-admin built-in role or a custom role instead.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EditableRoleEditor({ data }: { data: RoleEditorData }) {
  const router = useRouter();

  const isSystem = data.isSystem && data.systemKey !== null;

  const [name, setName] = useState(data.name);
  const [description, setDescription] = useState(data.description ?? "");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(data.capabilities),
  );
  const [limits, setLimits] = useState<LimitsForm>(() => toLimitsForm(data));
  // RoleV2 P4 — per-role landing route. "" = no override (today's routing).
  const [landingRoute, setLandingRoute] = useState(data.landingRoute ?? "");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [code, setCode] = useState("");
  // Separate 2FA code for the delete flow (its own dialog).
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteCode, setDeleteCode] = useState("");
  const [isPending, startTransition] = useTransition();

  // ── Baseline snapshots (what's persisted) for dirty + diff ────────────────
  const savedCaps = useMemo(
    () => [...data.capabilities].sort(),
    [data.capabilities],
  );
  const savedLimits = useMemo(() => toLimitsForm(data), [data]);

  const capsDirty = useMemo(() => {
    const cur = [...selected].sort();
    if (cur.length !== savedCaps.length) return true;
    return cur.some((k, i) => k !== savedCaps[i]);
  }, [selected, savedCaps]);

  const descDirty = (data.description ?? "") !== description;
  // RoleV2 P3: the name is editable for EVERY role except the `admin` superuser
  // (data.bypass). The 5 other system rows can be renamed cosmetically — their
  // identity stays `system_key`/enum. (`admin` renders read-only entirely.)
  const nameDirty = !data.bypass && data.name !== name;
  // RoleV2 P4: landing-route override change.
  const landingDirty = (data.landingRoute ?? "") !== landingRoute;
  const limitsDirty = useMemo(
    () => JSON.stringify(limits) !== JSON.stringify(savedLimits),
    [limits, savedLimits],
  );
  const dirty =
    capsDirty || descDirty || nameDirty || landingDirty || limitsDirty;

  // ── Capability diff (added / removed vs persisted) ────────────────────────
  const { added, removed } = useMemo(() => {
    const savedSet = new Set(data.capabilities);
    const addedKeys: string[] = [];
    const removedKeys: string[] = [];
    for (const k of selected) if (!savedSet.has(k)) addedKeys.push(k);
    for (const k of data.capabilities) if (!selected.has(k)) removedKeys.push(k);
    return { added: addedKeys.sort(), removed: removedKeys.sort() };
  }, [selected, data.capabilities]);

  // ── Limit diff rows (period → old/new) for both groups ────────────────────
  const limitDiffs = useMemo(() => {
    const rows: {
      group: string;
      period: string;
      from: string;
      to: string;
      enforced: boolean;
    }[] = [];
    const groups: {
      key: keyof LimitsForm;
      label: string;
      enforced: boolean;
    }[] = [
      { key: "balanceAdjustment", label: "Balance", enforced: true },
      { key: "issuance", label: "Issuance", enforced: false },
    ];
    for (const g of groups) {
      for (const p of ["daily", "weekly", "monthly"] as const) {
        const from = savedLimits[g.key][p];
        const to = limits[g.key][p];
        if (from !== to) {
          rows.push({
            group: g.label,
            period: p,
            from: from === "" ? "unlimited" : fmtMoney(from),
            to: to === "" ? "unlimited" : fmtMoney(to),
            enforced: g.enforced,
          });
        }
      }
    }
    return rows;
  }, [limits, savedLimits]);

  function openConfirm() {
    // Validate limit inputs up front so the dialog can't open with garbage.
    const allInputs = ([] as string[]).concat(
      Object.values(limits.balanceAdjustment),
      Object.values(limits.issuance),
    );
    for (const v of allInputs) {
      if (parseLimitInput(v) === undefined) {
        toast.error("Limits must be a positive number or left empty");
        return;
      }
    }
    if (!data.bypass && !name.trim()) {
      toast.error("Name is required");
      return;
    }
    setConfirmOpen(true);
  }

  function buildLimitsPayload():
    | {
        balanceAdjustment?: Record<string, number | null>;
        issuance?: Record<string, number | null>;
      }
    | null {
    // Only send slots that actually changed (the action leaves omitted columns
    // untouched and rejects an all-empty payload).
    const out: {
      balanceAdjustment?: Record<string, number | null>;
      issuance?: Record<string, number | null>;
    } = {};
    for (const key of ["balanceAdjustment", "issuance"] as const) {
      const changed: Record<string, number | null> = {};
      for (const p of ["daily", "weekly", "monthly"] as const) {
        if (limits[key][p] !== savedLimits[key][p]) {
          const parsed = parseLimitInput(limits[key][p]);
          // parsed === undefined is already blocked in openConfirm.
          changed[p] = parsed === undefined ? null : parsed;
        }
      }
      if (Object.keys(changed).length > 0) out[key] = changed;
    }
    return out.balanceAdjustment || out.issuance ? out : null;
  }

  function handleSave() {
    if (!code.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        // 1) Capabilities + description + name + landing route. Run only if any
        //    of those changed — limits have their own action.
        if (capsDirty || descDirty || nameDirty || landingDirty) {
          // Empty landing input = clear the override (→ today's routing).
          const landingArg = landingDirty
            ? landingRoute.trim() === ""
              ? null
              : landingRoute.trim()
            : undefined;
          if (isSystem && data.systemKey) {
            const res = await updateBuiltInRole(data.systemKey, {
              capabilities: [...selected],
              description: description.trim() || null,
              // P3: write the display name only when it changed (identity stays
              // system_key). P4: landing route when it changed.
              ...(nameDirty ? { name: name.trim() } : {}),
              ...(landingArg !== undefined ? { landingRoute: landingArg } : {}),
              code: code.trim(),
            });
            toast.success(
              res.usersRematerialized > 0
                ? `Role updated — ${res.usersRematerialized} user(s) re-materialized`
                : "Role updated",
            );
          } else {
            const res = await updateRole({
              id: data.id,
              name: name.trim(),
              description: description.trim() || null,
              capabilities: [...selected],
              ...(landingArg !== undefined ? { landingRoute: landingArg } : {}),
              code: code.trim(),
            });
            if (!res.ok) {
              toast.error(res.error);
              return;
            }
            toast.success(
              data.affectedUserCount > 0
                ? `Role updated — ${data.affectedUserCount} assigned user(s) refreshed`
                : "Role updated",
            );
          }
        }

        // 2) Limits (separate 2FA-gated action; no re-materialization).
        const limitsPayload = buildLimitsPayload();
        if (limitsPayload) {
          const res = await setRoleLimits(data.id, limitsPayload, code.trim());
          if (!res.success) {
            toast.error(res.error);
            return;
          }
          if (!(capsDirty || descDirty || nameDirty || landingDirty)) {
            toast.success("Role limits updated");
          }
        }

        setConfirmOpen(false);
        setCode("");
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to update role",
        );
      }
    });
  }

  function handleDelete() {
    if (!deleteCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      const res = await deleteRole(data.id, deleteCode.trim());
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Role deleted");
      router.push("/admin-users?tab=roles");
    });
  }

  const capCount = [...selected].filter((k) => k.startsWith("__")).length;
  const pageCount = selected.size - capCount;

  return (
    <div className="space-y-6">
      {/* ── Identity ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            {isSystem ? (
              <Lock className="size-4 text-amber-500" />
            ) : (
              <KeyRound className="size-4 text-emerald-500" />
            )}
            Identity
            <Badge
              variant="outline"
              className={cn(
                "ml-1 text-[10px] font-medium",
                isSystem
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
              )}
            >
              {isSystem ? "Built-in" : "Custom"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="role-name">Name</Label>
              <Input
                id="role-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isPending}
              />
              {isSystem && (
                <p className="text-[11px] text-muted-foreground">
                  Display name only — this stays a built-in role with the same
                  identity and access.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Assigned users</Label>
              <div className="flex h-9 items-center gap-1.5 text-sm text-muted-foreground">
                <Users className="size-3.5" />
                {data.holderCount} {isSystem ? "holder" : "assigned"}
                {data.holderCount === 1 ? "" : "s"}
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-description">Description</Label>
            <Textarea
              id="role-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              disabled={isPending}
            />
          </div>
          {/* ── Landing page (RoleV2 P4) ── */}
          <div className="space-y-1.5">
            <Label htmlFor="role-landing">Landing page</Label>
            <Select
              value={landingRoute === "" ? LANDING_DEFAULT : landingRoute}
              onValueChange={(v) =>
                setLandingRoute(v === LANDING_DEFAULT ? "" : (v ?? ""))
              }
            >
              <SelectTrigger
                id="role-landing"
                className="w-full"
                disabled={isPending}
              >
                <SelectValue placeholder="Default (role's home)">
                  {(value: string) =>
                    !value || value === LANDING_DEFAULT
                      ? "Default (role's home)"
                      : landingLabel(value)
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value={LANDING_DEFAULT}>
                  Default (role&apos;s home)
                </SelectItem>
                {LANDING_PAGE_GROUPS.map((g) => (
                  <SelectGroup key={g.group}>
                    <SelectLabel>{g.group}</SelectLabel>
                    {g.pages.map((p) => (
                      <SelectItem key={p.key} value={p.key}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Where a holder of this role lands after signing in. Default uses
              the role&apos;s usual home. Must be a page the role can reach.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ── Pages + Capabilities ─────────────────────────────────────── */}
      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Access
          </h2>
          <Badge variant="outline" className="text-xs">
            {pageCount} pages · {capCount} capabilities ·{" "}
            {selected.size}/{ALL_PERMISSION_KEYS.length}
          </Badge>
        </div>
        <PermissionPicker
          selected={selected}
          onChange={setSelected}
          disabled={isPending}
          control="switch"
          deadCapKeys={DEAD_CAPABILITY_KEYS}
        />
      </div>

      {/* ── Limits ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <SlidersHorizontal className="size-4 text-cyan-500" />
            Limits
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <LimitGroup
            title="Balance adjustment (USD)"
            helper="Empty = no role default — unlimited unless set per-user. A per-user balance limit on a user's profile overrides this role default."
            value={limits.balanceAdjustment}
            disabled={isPending}
            onChange={(next) =>
              setLimits((l) => ({ ...l, balanceAdjustment: next }))
            }
          />
          <LimitGroup
            title="Issuance (USD)"
            helper="Schema ready · enforcement pending. These columns are saved but not yet enforced at issuance time."
            badge="enforcement pending"
            value={limits.issuance}
            disabled={isPending}
            onChange={(next) => setLimits((l) => ({ ...l, issuance: next }))}
          />
        </CardContent>
      </Card>

      {/* ── Footer actions ───────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 border-t pt-4">
        {!isSystem ? (
          <AlertDialog
            open={deleteOpen}
            onOpenChange={(v) => {
              setDeleteOpen(v);
              if (!v) setDeleteCode("");
            }}
          >
            <AlertDialogTrigger
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50",
              )}
              disabled={isPending}
            >
              <Trash2 className="size-4" />
              Delete role
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Delete role &quot;{data.name}&quot;?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {data.holderCount > 0
                    ? `${data.holderCount} user(s) will lose this role link. They keep their current effective permissions — you can assign a different role any time.`
                    : "This cannot be undone."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <StepUpField value={deleteCode} onChange={setDeleteCode} />
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    // Keep open until the action resolves (so errors surface).
                    e.preventDefault();
                    handleDelete();
                  }}
                  disabled={isPending || !deleteCode.trim()}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <span />
        )}

        <div className="flex items-center gap-2">
          {dirty && (
            <span className="text-xs text-amber-500">Unsaved changes</span>
          )}
          <Button size="sm" onClick={openConfirm} disabled={!dirty || isPending}>
            <Save className="size-4" />
            Review &amp; save
          </Button>
        </div>
      </div>

      {/* ── Save-preview diff + 2FA ──────────────────────────────────── */}
      <Dialog
        open={confirmOpen}
        onOpenChange={(v) => {
          setConfirmOpen(v);
          if (!v) setCode("");
        }}
      >
        <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-md">
          <DialogHeader className="border-b p-4 sm:p-5">
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="size-4 text-blue-500" />
              Review role changes
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[calc(85vh-9rem)] space-y-3 overflow-y-auto p-4 sm:p-5">
            {nameDirty && (
              <p className="text-xs text-muted-foreground">
                Name → <span className="font-medium text-foreground">{name}</span>
              </p>
            )}
            {descDirty && (
              <p className="text-xs text-muted-foreground">
                Description updated.
              </p>
            )}
            {landingDirty && (
              <p className="text-xs text-muted-foreground">
                Landing page →{" "}
                <span className="font-medium text-foreground">
                  {landingRoute === ""
                    ? "Default (role's home)"
                    : landingLabel(landingRoute)}
                </span>
              </p>
            )}

            <CapDiffRow label="Capabilities added" tone="added" tokens={added} />
            <CapDiffRow
              label="Capabilities removed"
              tone="removed"
              tokens={removed}
            />

            {limitDiffs.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400">
                  Limits changed ({limitDiffs.length})
                </div>
                <div className="space-y-1">
                  {limitDiffs.map((r) => (
                    <div
                      key={`${r.group}-${r.period}`}
                      className="flex items-center gap-1.5 text-xs"
                    >
                      <span className="capitalize text-muted-foreground">
                        {r.group} {r.period}:
                      </span>
                      <span className="font-medium text-foreground">
                        {r.from} → {r.to}
                      </span>
                      {!r.enforced && (
                        <Badge
                          variant="outline"
                          className="h-4 border-muted-foreground/30 bg-muted/40 px-1 text-[9px] font-medium text-muted-foreground"
                        >
                          not enforced yet
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(capsDirty || descDirty || nameDirty) && (
              <div className="flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs">
                <Users className="size-3.5 shrink-0 text-blue-500" />
                <span className="text-foreground">
                  <span className="font-medium">{data.affectedUserCount}</span>{" "}
                  user{data.affectedUserCount === 1 ? "" : "s"} will be
                  re-materialized
                </span>
              </div>
            )}

            {added.length === 0 &&
              removed.length === 0 &&
              limitDiffs.length === 0 &&
              !descDirty &&
              !nameDirty &&
              !landingDirty && (
                <p className="text-sm text-muted-foreground">No changes.</p>
              )}

            <p className="text-xs text-muted-foreground">
              Saving applies these changes to the role. Enter your 2FA code to
              confirm.
            </p>
            <StepUpField value={code} onChange={setCode} />
          </div>
          <DialogFooter className="border-t p-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirmOpen(false);
                setCode("");
              }}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={isPending || !code.trim()}
            >
              {isPending && <Spinner size={14} className="text-current" />}
              {isPending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ── helpers ── */

function fmtMoney(raw: string): string {
  const n = Number(raw);
  return Number.isFinite(n) ? formatCurrency(n) : raw;
}

/** Human label for a landing-route page key (its ADMIN_PAGES label, or tail). */
function landingLabel(route: string): string {
  const page = ADMIN_PAGES.find((p) => p.key === route);
  if (page) return page.label;
  const tail = route.split("/").filter(Boolean).pop() ?? route;
  return tail.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Look up a capability's human label; fall back to the token describer. */
function capLabel(token: string): string {
  const cap = CAPABILITIES.find((c) => c.key === token);
  return cap?.label ?? describeToken(token).label;
}

function CapDiffRow({
  label,
  tone,
  tokens,
}: {
  label: string;
  tone: "added" | "removed";
  tokens: string[];
}) {
  if (tokens.length === 0) return null;
  const cls =
    tone === "added"
      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
      : "border-rose-500/30 bg-rose-500/5 text-rose-600 dark:text-rose-400";
  const Icon = tone === "added" ? Plus : Minus;
  return (
    <div className="space-y-1.5">
      <div
        className={cn(
          "flex items-center gap-1.5 text-xs font-semibold",
          tone === "added"
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-rose-600 dark:text-rose-400",
        )}
      >
        <Icon className="size-3.5" />
        {label} ({tokens.length})
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tokens.map((tok) => (
          <Badge
            key={tok}
            variant="outline"
            title={tok}
            className={cn("max-w-full gap-1 font-normal", cls)}
          >
            <span className="truncate">{capLabel(tok)}</span>
          </Badge>
        ))}
      </div>
    </div>
  );
}

function LimitGroup({
  title,
  helper,
  badge,
  value,
  disabled,
  onChange,
}: {
  title: string;
  helper: string;
  badge?: string;
  value: LimitPeriods;
  disabled: boolean;
  onChange: (next: LimitPeriods) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-sm">{title}</Label>
        {badge && (
          <Badge
            variant="outline"
            className="h-4 border-muted-foreground/30 bg-muted/40 px-1 text-[9px] font-medium text-muted-foreground"
          >
            {badge}
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(["daily", "weekly", "monthly"] as const).map((p) => (
          <div key={p} className="space-y-1">
            <Label
              htmlFor={`${title}-${p}`}
              className="text-[11px] capitalize text-muted-foreground"
            >
              {p}
            </Label>
            <Input
              id={`${title}-${p}`}
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              placeholder="Unlimited"
              value={value[p]}
              onChange={(e) => onChange({ ...value, [p]: e.target.value })}
              disabled={disabled}
            />
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">{helper}</p>
    </div>
  );
}
