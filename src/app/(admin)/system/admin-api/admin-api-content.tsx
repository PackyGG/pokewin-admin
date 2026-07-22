"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { KeyRound, Plus, ShieldAlert, TriangleAlert } from "lucide-react";

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
  type ApiScope,
} from "@/lib/api-auth/scopes";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";

export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
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
          <EmptyState
            icon={KeyRound}
            title="No API keys yet"
            description="Create one to give the Discord bot (or an in-house script) scoped access."
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
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={revoked || isPending}
                        onClick={() => setRevokeTarget(key)}
                      >
                        Revoke
                      </Button>
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
  const [isPending, startTransition] = useTransition();

  function reset() {
    setName("");
    setScopes([]);
    setExpiresInDays("365");
    setRateLimit("120");
  }

  const fullAccess = hasFullAccess(scopes);

  function toggleScope(scope: ApiScope) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  /** Wildcard supersedes the rest — store it alone so the grant is unambiguous. */
  function toggleFullAccess() {
    setScopes((prev) =>
      hasFullAccess(prev) ? [] : [FULL_ACCESS_SCOPE as ApiScope],
    );
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

            {/* Wildcard first, visually separated — it supersedes everything
                below, so burying it among the granular options would make it
                easy to tick by accident. */}
            <ScopeOption
              scope={FULL_ACCESS_SCOPE}
              checked={fullAccess}
              disabled={isPending}
              onToggle={toggleFullAccess}
            />

            {fullAccess && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  This key can call <strong>every</strong> endpoint — including ones
                  added in future, without being re-issued. Only grant it to a
                  trusted first-party consumer.
                </span>
              </div>
            )}

            <div
              className={cn(
                "space-y-1.5",
                fullAccess && "pointer-events-none opacity-40",
              )}
              aria-disabled={fullAccess}
            >
              {GRANULAR_API_SCOPES.map((scope) => (
                <ScopeOption
                  key={scope}
                  scope={scope}
                  checked={scopes.includes(scope)}
                  disabled={isPending || fullAccess}
                  onToggle={() => toggleScope(scope)}
                />
              ))}
            </div>
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
