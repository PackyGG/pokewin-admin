"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  KeyRound,
  Lock,
  Plus,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { CopyButton } from "@/components/copy-button";
import { RelativeTime } from "@/components/relative-time";
import { cn } from "@/lib/utils";
import {
  API_SCOPES,
  FULL_ACCESS_SCOPE,
  GRANULAR_API_SCOPES,
  hasFullAccess,
  toApiScopes,
  type ApiScope,
} from "@/lib/api-auth/scopes";
import {
  createApiKeyAction,
  revokeApiKeyAction,
  updateApiKeyIpsAction,
  updateApiKeyScopesAction,
} from "./actions";

export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  allowedIps: string[];
  isActive: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  requestCount: number;
  createdAt: string;
  revokedAt: string | null;
};

type Status = { label: string; className: string };

const ACCESS_BADGE: Record<string, { label: string; className: string }> = {
  full: {
    label: "full access",
    className: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  },
  "admin-write": {
    label: "admin DB write",
    className: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  "prod-read": {
    label: "prod read-only",
    className: "bg-muted text-muted-foreground",
  },
};

/** One selectable scope row in the create dialog. */
function ScopeOption({
  scope,
  checked,
  disabled,
  onToggle,
}: {
  scope: ApiScope;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const meta = API_SCOPES[scope];
  const badge = ACCESS_BADGE[meta.access] ?? ACCESS_BADGE["prod-read"]!;
  const isFull = scope === FULL_ACCESS_SCOPE;
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors",
        checked
          ? isFull
            ? "border-rose-500/40 bg-rose-500/5"
            : "border-primary/40 bg-primary/5"
          : "hover:bg-muted/40",
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        disabled={disabled}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-xs font-medium">{scope}</code>
          <span className="text-xs font-medium">{meta.label}</span>
          <Badge variant="outline" className={cn("text-[10px]", badge.className)}>
            {badge.label}
          </Badge>
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {meta.description}
        </span>
      </span>
    </label>
  );
}

/**
 * The scope picker, shared by "new key" and "edit access" so the two can't
 * drift on the wildcard rule: ticking full access CLEARS the granular
 * selection and stores `*` alone, because it already satisfies every check and
 * a mixed list would read as narrower than the grant really is.
 */
function ScopePicker({
  scopes,
  onChange,
  disabled,
}: {
  scopes: ApiScope[];
  onChange: (next: ApiScope[]) => void;
  disabled: boolean;
}) {
  const fullAccess = hasFullAccess(scopes);

  return (
    <div className="space-y-2">
      {/* Wildcard first, visually separated — it supersedes everything below,
          so burying it among the granular options would make it easy to tick
          by accident. */}
      <ScopeOption
        scope={FULL_ACCESS_SCOPE}
        checked={fullAccess}
        disabled={disabled}
        onToggle={() =>
          onChange(fullAccess ? [] : [FULL_ACCESS_SCOPE as ApiScope])
        }
      />

      {fullAccess && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            This key can call <strong>every</strong> endpoint — including ones
            added in future, without being re-issued. Only grant it to a trusted
            first-party consumer.
          </span>
        </div>
      )}

      <div
        className={cn("space-y-1.5", fullAccess && "pointer-events-none opacity-40")}
        aria-disabled={fullAccess}
      >
        {GRANULAR_API_SCOPES.map((scope) => (
          <ScopeOption
            key={scope}
            scope={scope}
            checked={scopes.includes(scope)}
            disabled={disabled || fullAccess}
            onToggle={() =>
              onChange(
                scopes.includes(scope)
                  ? scopes.filter((s) => s !== scope)
                  : [...scopes, scope],
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

function statusOf(key: ApiKeyRow): Status {
  if (key.revokedAt || !key.isActive) {
    return { label: "Revoked", className: "bg-rose-500/15 text-rose-600 dark:text-rose-400" };
  }
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) {
    return { label: "Expired", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" };
  }
  return { label: "Active", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" };
}

export function ApiKeysContent({ keys }: { keys: ApiKeyRow[] }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [ipTarget, setIpTarget] = useState<ApiKeyRow | null>(null);
  const [scopeTarget, setScopeTarget] = useState<ApiKeyRow | null>(null);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleRevoke(key: ApiKeyRow) {
    startTransition(async () => {
      const res = await revokeApiKeyAction(key.id);
      if (res.success) {
        toast.success(`"${key.name}" revoked — it stops working immediately`);
        setRevokeTarget(null);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Keys authenticate as <code className="font-mono text-xs">Authorization: Bearer …</code>{" "}
          against <code className="font-mono text-xs">/api/v1/*</code>. Scoped, rate-limited,
          and revocable instantly.
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 size-4" />
          New key
        </Button>
      </div>

      {keys.length === 0 ? (
        <div className="rounded-xl border">
          {/* "active" is deliberate — revoked keys are filtered out server-side,
              so this state can also mean "every key was revoked". */}
          <EmptyState
            icon={KeyRound}
            title="No active API keys"
            description="Create one to give the Discord bot (or an in-house script) scoped access. Revoked keys are hidden."
            compact
          />
        </div>
      ) : (
        <div className="rounded-xl border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => {
                const status = statusOf(key);
                const revoked = Boolean(key.revokedAt) || !key.isActive;
                return (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">
                      <span className="block truncate">{key.name}</span>
                      <span className="block text-xs font-normal text-muted-foreground">
                        {key.requestCount.toLocaleString()} requests
                      </span>
                    </TableCell>
                    <TableCell>
                      <code className="font-mono text-xs text-muted-foreground">
                        {key.prefix}…
                      </code>
                      {/* An IP-locked key is meaningfully safer than an open
                          one — surface which is which without a click. */}
                      {key.allowedIps.length > 0 && (
                        <span
                          className="mt-0.5 flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400"
                          title={key.allowedIps.join(", ")}
                        >
                          <Lock className="size-2.5" />
                          {key.allowedIps.length === 1
                            ? key.allowedIps[0]
                            : `${key.allowedIps.length} IPs`}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        {key.scopes.length === 0 ? (
                          <span className="text-xs text-muted-foreground">none</span>
                        ) : hasFullAccess(key.scopes) ? (
                          // Loud on purpose: a wildcard key is materially
                          // different from a scoped one at a glance.
                          <Badge
                            variant="outline"
                            className="bg-rose-500/15 text-[10px] text-rose-600 dark:text-rose-400"
                          >
                            full access
                          </Badge>
                        ) : (
                          key.scopes.map((s) => (
                            <Badge key={s} variant="outline" className="text-[10px]">
                              {s}
                            </Badge>
                          ))
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={status.className}>
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {key.lastUsedAt ? <RelativeTime date={key.lastUsedAt} /> : "never"}
                      {key.lastUsedIp && (
                        <span className="block font-mono">{key.lastUsedIp}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={revoked || isPending}
                          onClick={() => setScopeTarget(key)}
                        >
                          <ShieldCheck className="mr-1 size-3.5" />
                          Access
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={revoked || isPending}
                          onClick={() => setIpTarget(key)}
                        >
                          <Lock className="mr-1 size-3.5" />
                          IPs
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          disabled={revoked || isPending}
                          onClick={() => setRevokeTarget(key)}
                        >
                          Revoke
                        </Button>
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onIssued={(token) => {
          setCreateOpen(false);
          setIssuedToken(token);
        }}
      />

      <EditScopesDialog
        target={scopeTarget}
        onClose={() => setScopeTarget(null)}
      />

      <EditIpsDialog
        target={ipTarget}
        onClose={() => setIpTarget(null)}
      />

      {/* Token is shown EXACTLY once — it is not recoverable afterwards. */}
      <Dialog open={issuedToken !== null} onOpenChange={() => setIssuedToken(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Copy your API key now</DialogTitle>
            <DialogDescription>
              This is the only time it will ever be shown. It is stored hashed — we
              cannot show or recover it again. Losing it means creating a new key.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">
              {issuedToken}
            </code>
            {issuedToken && <CopyButton value={issuedToken} label="API key" />}
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Treat it like a password: store it in the bot&apos;s secret manager, never
              in source control or a Discord message.
            </span>
          </div>
          <DialogFooter>
            <Button onClick={() => setIssuedToken(null)}>I&apos;ve saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke &quot;{revokeTarget?.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              The key stops working immediately — every request using it starts failing
              with 401. This cannot be undone; you&apos;d need to issue a new key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={() => revokeTarget && handleRevoke(revokeTarget)}
            >
              {isPending ? "Revoking…" : "Revoke key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Edit an existing key's scopes without re-issuing the token — grant a
 * newly-added endpoint to a live bot, or cut a key back to least privilege,
 * with no redeploy on the consumer's side.
 *
 * Removing a scope is a BREAKING change for that caller (403 on the affected
 * endpoints from the next request onwards), so the pending removals are spelled
 * out before saving rather than left as a diff the operator has to compute.
 *
 * Keyed on `target.id` so the selection re-initialises per key instead of
 * holding the previously-opened key's scopes.
 */
function EditScopesDialog({
  target,
  onClose,
}: {
  target: ApiKeyRow | null;
  onClose: () => void;
}) {
  const [scopes, setScopes] = useState<ApiScope[]>(() =>
    toApiScopes(target?.scopes ?? []),
  );
  const [isPending, startTransition] = useTransition();

  // Re-seed whenever a different key is opened.
  const [seededFor, setSeededFor] = useState(target?.id ?? null);
  if (target && seededFor !== target.id) {
    setSeededFor(target.id);
    setScopes(toApiScopes(target.scopes));
  }

  // Compare against the key's CURRENT scopes, narrowed the same way, so a
  // stale scope left on the row doesn't show up as a removal the operator
  // never made.
  const current = toApiScopes(target?.scopes ?? []);
  const added = scopes.filter((s) => !current.includes(s));
  const removed = current.filter((s) => !scopes.includes(s));
  const unchanged = added.length === 0 && removed.length === 0;

  function submit() {
    if (!target) return;
    startTransition(async () => {
      const res = await updateApiKeyScopesAction({ keyId: target.id, scopes });
      if (res.success) {
        toast.success(
          hasFullAccess(res.scopes)
            ? `"${target.name}" now has full access`
            : `"${target.name}" updated — ${res.scopes.length} scope${res.scopes.length === 1 ? "" : "s"}`,
        );
        onClose();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Access — {target?.name}</DialogTitle>
          <DialogDescription>
            Takes effect on the next request. The token itself is unchanged, so
            the consumer needs no redeploy.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto pr-0.5">
          <ScopePicker scopes={scopes} onChange={setScopes} disabled={isPending} />
        </div>

        {removed.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Removing{" "}
              {removed.map((scope, i) => (
                <span key={scope}>
                  {i > 0 && ", "}
                  <code className="font-mono">{scope}</code>
                </span>
              ))}{" "}
              — calls to those endpoints start failing with{" "}
              <strong>403</strong> immediately.
            </span>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={isPending || scopes.length === 0 || unchanged}
          >
            {isPending ? "Saving…" : "Save access"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Edit an existing key's IP allowlist without re-issuing the token — so a live
 * bot can be re-pointed at a new egress IP, or an already-deployed key locked
 * down after the fact.
 *
 * Keyed on `target.id` by the caller so the input re-initialises per key
 * instead of holding the previously-opened key's value.
 */
function EditIpsDialog({
  target,
  onClose,
}: {
  target: ApiKeyRow | null;
  onClose: () => void;
}) {
  const [value, setValue] = useState(target?.allowedIps.join(", ") ?? "");
  const [isPending, startTransition] = useTransition();

  // Re-seed whenever a different key is opened.
  const [seededFor, setSeededFor] = useState(target?.id ?? null);
  if (target && seededFor !== target.id) {
    setSeededFor(target.id);
    setValue(target.allowedIps.join(", "));
  }

  function submit() {
    if (!target) return;
    const allowedIps = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    startTransition(async () => {
      const res = await updateApiKeyIpsAction({
        keyId: target.id,
        allowedIps,
      });
      if (res.success) {
        toast.success(
          res.allowedIps.length === 0
            ? `"${target.name}" is now callable from any IP`
            : `"${target.name}" locked to ${res.allowedIps.length} IP${res.allowedIps.length === 1 ? "" : "s"}`,
        );
        onClose();
      } else {
        toast.error(res.error);
      }
    });
  }

  const willClear = value.trim() === "" && (target?.allowedIps.length ?? 0) > 0;

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Allowed IPs — {target?.name}</DialogTitle>
          <DialogDescription>
            Takes effect on the next request. The token itself is unchanged, so
            the bot needs no redeploy.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="edit-key-ips">IP addresses</Label>
          <Input
            id="edit-key-ips"
            placeholder="blank = any IP · e.g. 203.0.113.7, 203.0.113.8"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={isPending}
          />
          <p className="text-xs text-muted-foreground">
            Comma-separated, exact addresses (no CIDR ranges).
          </p>
        </div>

        {willClear && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Clearing this removes the restriction — the key becomes callable
              from <strong>any</strong> IP again.
            </span>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onIssued,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued: (token: string) => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [expiresInDays, setExpiresInDays] = useState("365");
  const [rateLimit, setRateLimit] = useState("120");
  const [allowedIps, setAllowedIps] = useState("");
  const [isPending, startTransition] = useTransition();

  function reset() {
    setName("");
    setScopes([]);
    setExpiresInDays("365");
    setRateLimit("120");
    setAllowedIps("");
  }

  function submit() {
    const days = expiresInDays.trim() === "" ? null : Number(expiresInDays);
    if (days !== null && (!Number.isInteger(days) || days < 1)) {
      toast.error("Expiry must be a whole number of days (or blank for none)");
      return;
    }
    const rpm = Number(rateLimit);
    if (!Number.isInteger(rpm) || rpm < 1) {
      toast.error("Rate limit must be a positive whole number");
      return;
    }
    startTransition(async () => {
      const res = await createApiKeyAction({
        name: name.trim(),
        scopes,
        expiresInDays: days,
        rateLimitPerMin: rpm,
        allowedIps: allowedIps
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      });
      if (res.success) {
        toast.success("API key created");
        reset();
        onIssued(res.token);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New API key</DialogTitle>
          <DialogDescription>
            Grant the narrowest scope set that works — you can always issue a second
            key rather than widening this one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="api-key-name">Name</Label>
            <Input
              id="api-key-name"
              placeholder="Discord bot"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isPending}
            />
          </div>

          <div className="space-y-2">
            <Label>Scopes</Label>
            <ScopePicker scopes={scopes} onChange={setScopes} disabled={isPending} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="api-key-expiry">Expires in (days)</Label>
              <Input
                id="api-key-expiry"
                inputMode="numeric"
                placeholder="blank = never"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="api-key-rate">Rate limit (req/min)</Label>
              <Input
                id="api-key-rate"
                inputMode="numeric"
                value={rateLimit}
                onChange={(e) => setRateLimit(e.target.value)}
                disabled={isPending}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="api-key-ips">Allowed IPs (optional)</Label>
            <Input
              id="api-key-ips"
              placeholder="blank = any IP · e.g. 203.0.113.7, 203.0.113.8"
              value={allowedIps}
              onChange={(e) => setAllowedIps(e.target.value)}
              disabled={isPending}
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated. Lock the key to your Railway egress IP so a leaked
              token is useless from anywhere else. Exact addresses only (no CIDR
              ranges) — list each one.
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              The key is shown once on creation and stored hashed — it can never be
              retrieved again.
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={isPending || name.trim().length < 2 || scopes.length === 0}
          >
            {isPending ? "Creating…" : "Create key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
