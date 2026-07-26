"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ShieldCheck,
  Lock,
  Plus,
  Minus,
  Layers,
  Eye,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StepUpField } from "@/components/step-up-field";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ux";
import { updateUserPermissions } from "./actions";
import { PermissionPicker } from "../_components/permission-picker";
import { describeToken } from "../_components/token-describe";
import type { AdminUserDetail } from "@/lib/queries/admin-users";

/* ── Per-user permission editor (Phase C) ──
 *
 * Edits the user's per-user OVERRIDE layer (explicit grants / revokes) on top
 * of their LOCKED role baseline (built-in role tokens ∪ custom-role tokens).
 * The effective set the gate sees is `baseline ∪ grants \ revokes`.
 *
 * The picker works in the EFFECTIVE vocabulary: a checked token is in the
 * effective set. Toggling a token relative to its baseline state derives the
 * override:
 *   • a baseline token turned OFF  → a revoke
 *   • a non-baseline token ON      → a grant
 * On save we send the derived { grants, revokes } to `updateUserPermissions`,
 * which persists both columns AND re-materializes `allowed_pages` (the runtime
 * cache the gate reads) through the one canonical materializer. 2FA-gated.
 *
 * For an `admin`-role target (gate bypass) there is nothing to edit: we show a
 * full-access banner instead of the editor.
 */

type TokenChip = { token: string; label: string; sticky: boolean };

/**
 * Thin dispatcher: admins (gate bypass) get a full-access banner with NO
 * editable controls; everyone else gets the override editor. Split into two
 * components so neither calls hooks conditionally (the editor is hook-heavy).
 */
export function PermissionsSection({ detail }: { detail: AdminUserDetail }) {
  if (detail.isGateBypass) return <BypassBanner />;
  return <OverrideEditor detail={detail} />;
}

function BypassBanner() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-emerald-500" />
          Permissions
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              Full access — overrides recorded but not enforced
            </p>
            <p className="text-muted-foreground">
              This user holds the <span className="font-medium">admin</span>{" "}
              role and bypasses every page and capability check. Per-user grants
              and revokes are not applied while they are an admin. To scope their
              access, change their role first.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function OverrideEditor({ detail }: { detail: AdminUserDetail }) {
  const router = useRouter();

  // Baseline = built-in role tokens ∪ custom-role tokens (read-only source).
  const baselineSet = useMemo(
    () => new Set(detail.baselineTokens.map((b) => b.token)),
    [detail.baselineTokens],
  );
  const stickySet = useMemo(
    () => new Set(detail.stickyTokens),
    [detail.stickyTokens],
  );

  // Effective working copy — starts at the user's current allowed_pages (the
  // runtime cache). `savedEffective` mirrors what is persisted.
  const [savedEffective, setSavedEffective] = useState<string[]>(
    detail.allowedPages,
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(detail.allowedPages),
  );
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();

  // ── Derive the override from the current effective selection vs baseline ──
  const savedSet = useMemo(() => new Set(savedEffective), [savedEffective]);
  const isDirty =
    selected.size !== savedSet.size ||
    [...selected].some((k) => !savedSet.has(k));

  // grants = effective \ baseline ; revokes = baseline \ effective
  const grants: TokenChip[] = useMemo(() => {
    return [...selected]
      .filter((k) => !baselineSet.has(k))
      .map((token) => ({ token, ...chipMeta(token, stickySet) }))
      .sort(sortChips);
  }, [selected, baselineSet, stickySet]);

  const revokes: TokenChip[] = useMemo(() => {
    return [...baselineSet]
      .filter((k) => !selected.has(k))
      .map((token) => ({ token, ...chipMeta(token, stickySet) }))
      .sort(sortChips);
  }, [selected, baselineSet, stickySet]);

  // Saved override (what's persisted now) — drives the save-preview diff so we
  // show what CHANGES, not the full override.
  const savedGrants = useMemo(
    () => new Set(savedEffective.filter((k) => !baselineSet.has(k))),
    [savedEffective, baselineSet],
  );
  const savedRevokes = useMemo(
    () => new Set([...baselineSet].filter((k) => !savedSet.has(k))),
    [baselineSet, savedSet],
  );

  // What the save will newly grant / revoke vs the saved state.
  const willGrant = grants.filter((g) => !savedGrants.has(g.token));
  const willUngrant = [...savedGrants].filter(
    (k) => !grants.some((g) => g.token === k),
  );
  const willRevoke = revokes.filter((r) => !savedRevokes.has(r.token));
  const willUnrevoke = [...savedRevokes].filter(
    (k) => !revokes.some((r) => r.token === k),
  );

  const effectiveAfter = [...selected].sort();

  const revokesHaveSticky = revokes.some((r) => r.sticky);

  function discard() {
    setSelected(new Set(savedEffective));
    setTotpCode("");
    setConfirmOpen(false);
  }

  function save() {
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        await updateUserPermissions(
          detail.id,
          {
            grants: grants.map((g) => g.token),
            revokes: revokes.map((r) => r.token),
          },
          totpCode.trim(),
        );
        toast.success("Permissions updated");
        setSavedEffective([...selected]);
        setConfirmOpen(false);
        setTotpCode("");
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to update permissions",
        );
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-blue-500" />
            Permissions
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Role baseline + per-user grants / revokes.{" "}
            {grants.length > 0 || revokes.length > 0 ? (
              <span>
                <span className="text-emerald-600 dark:text-emerald-400">
                  {grants.length} granted
                </span>
                {" · "}
                <span className="text-rose-600 dark:text-rose-400">
                  {revokes.length} revoked
                </span>
              </span>
            ) : (
              <span>No overrides — effective = role baseline.</span>
            )}
          </p>
        </div>
        {isDirty && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="ghost" onClick={discard} disabled={isPending}>
              Discard
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={isPending}
            >
              Review &amp; save
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {/* ── (a) Role baseline — read-only, collapsible, badged `from <role>` ── */}
        <div className="rounded-lg border bg-muted/30">
          <button
            type="button"
            onClick={() => setBaselineOpen((o) => !o)}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
          >
            <Lock className="size-3.5 shrink-0 text-amber-500" />
            <span className="text-sm font-medium">Role baseline</span>
            <Badge
              variant="outline"
              className="gap-1 border-amber-500/30 bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            >
              {detail.baselineTokens.length} token
              {detail.baselineTokens.length === 1 ? "" : "s"}
            </Badge>
            <span className="ml-auto text-[11px] text-muted-foreground">
              locked
            </span>
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                baselineOpen && "rotate-180",
              )}
            />
          </button>
          {baselineOpen && (
            <div className="border-t px-3 py-3">
              {detail.baselineTokens.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  This user&apos;s roles grant nothing by default — their access
                  is purely the per-user grants below.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {detail.baselineTokens
                    .slice()
                    .sort((a, b) => sortChips(chipFromBaseline(a), chipFromBaseline(b)))
                    .map((b) => {
                      const d = describeToken(b.token);
                      const revoked = !selected.has(b.token);
                      return (
                        <Badge
                          key={b.token}
                          variant="outline"
                          title={`${b.token} · from ${b.from.join(", ")}`}
                          className={cn(
                            "max-w-full gap-1 font-normal",
                            revoked
                              ? "border-rose-500/30 bg-rose-500/5 text-rose-600 line-through dark:text-rose-400"
                              : d.kind === "page"
                                ? "border-blue-500/30 bg-blue-500/5 text-blue-600 dark:text-blue-400"
                                : "border-border bg-muted/40 text-foreground/80",
                          )}
                        >
                          <span className="truncate">{d.label}</span>
                          <span className="shrink-0 text-[9px] opacity-70">
                            from {b.from.join(", ")}
                          </span>
                        </Badge>
                      );
                    })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── (b) Explicit grants / revokes summary ── */}
        <div className="grid gap-3 sm:grid-cols-2">
          <OverrideList
            title="Granted on top"
            icon={Plus}
            tone="emerald"
            empty="No extra grants."
            chips={grants}
          />
          <OverrideList
            title="Revoked from baseline"
            icon={Minus}
            tone="rose"
            empty="Nothing revoked."
            chips={revokes}
            footnote={
              revokesHaveSticky
                ? "Tokens marked sticky are guaranteed by the role and cannot be revoked. To remove one, change the user's role."
                : undefined
            }
          />
        </div>

        {/* ── (c) Effective preview ── */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs">
          <Eye className="size-3.5 shrink-0 text-blue-500" />
          <span className="font-medium text-foreground">
            Effective (gate sees)
          </span>
          <Badge
            variant="outline"
            className="border-blue-500/30 bg-blue-500/10 px-1.5 text-[10px] font-medium text-blue-600 dark:text-blue-400"
          >
            {selected.size} token{selected.size === 1 ? "" : "s"}
          </Badge>
          <span className="text-muted-foreground">
            = {detail.baselineTokens.length} baseline + {grants.length} granted −{" "}
            {revokes.length} revoked
          </span>
        </div>

        {/* ── The full effective picker ── */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Layers className="size-3.5" />
            Adjust access
          </div>
          <p className="text-[11px] text-muted-foreground">
            Checked = effective. Unchecking a baseline token revokes it; checking
            a non-baseline token grants it. Baseline tokens are tagged.
          </p>
          <PermissionPicker
            selected={selected}
            onChange={setSelected}
            disabled={isPending}
            baseline={baselineSet}
          />
        </div>
      </CardContent>

      {/* ── (d) Save-preview diff + 2FA ── */}
      <Dialog
        open={confirmOpen}
        onOpenChange={(v) => {
          setConfirmOpen(v);
          if (!v) setTotpCode("");
        }}
      >
        <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-md">
          <DialogHeader className="border-b p-4 sm:p-5">
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="size-4 text-blue-500" />
              Review permission changes
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[calc(85vh-9rem)] space-y-3 overflow-y-auto p-4 sm:p-5">
            <DiffRow
              label="Will grant"
              tone="emerald"
              tokens={willGrant.map((g) => g.token)}
            />
            <DiffRow
              label="Will revoke"
              tone="rose"
              tokens={willRevoke.map((r) => r.token)}
            />
            {(willUngrant.length > 0 || willUnrevoke.length > 0) && (
              <DiffRow
                label="Back to baseline"
                tone="muted"
                tokens={[...willUngrant, ...willUnrevoke]}
              />
            )}
            {willGrant.length === 0 &&
              willRevoke.length === 0 &&
              willUngrant.length === 0 &&
              willUnrevoke.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No net change to the override.
                </p>
              )}
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs">
              <span className="font-medium text-foreground">
                Effective after save:
              </span>{" "}
              <span className="text-muted-foreground">
                {effectiveAfter.length} token
                {effectiveAfter.length === 1 ? "" : "s"} (
                {grants.length} granted, {revokes.length} revoked)
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Saving re-materializes this user&apos;s access. Enter your 2FA code
              to confirm.
            </p>
            <StepUpField value={totpCode} onChange={setTotpCode} />
          </div>
          <DialogFooter className="border-t p-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirmOpen(false);
                setTotpCode("");
              }}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={isPending || !totpCode.trim()}>
              {isPending && <Spinner size={14} className="text-current" />}
              {isPending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/* ── helpers ── */

function chipMeta(token: string, stickySet: Set<string>): {
  label: string;
  sticky: boolean;
} {
  return { label: describeToken(token).label, sticky: stickySet.has(token) };
}

function chipFromBaseline(b: { token: string }): TokenChip {
  return { token: b.token, label: describeToken(b.token).label, sticky: false };
}

// Sort: pages first, then capabilities, then value tokens; alphabetical within.
function sortChips(a: TokenChip, b: TokenChip): number {
  const rank = (t: string) => {
    const k = describeToken(t).kind;
    return k === "page" ? 0 : k === "capability" ? 1 : 2;
  };
  const ra = rank(a.token);
  const rb = rank(b.token);
  if (ra !== rb) return ra - rb;
  return a.label.localeCompare(b.label);
}

const TONE: Record<
  "emerald" | "rose" | "muted",
  { badge: string; head: string }
> = {
  emerald: {
    badge:
      "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400",
    head: "text-emerald-600 dark:text-emerald-400",
  },
  rose: {
    badge: "border-rose-500/30 bg-rose-500/5 text-rose-600 dark:text-rose-400",
    head: "text-rose-600 dark:text-rose-400",
  },
  muted: {
    badge: "border-border bg-muted/40 text-foreground/70",
    head: "text-muted-foreground",
  },
};

function OverrideList({
  title,
  icon: Icon,
  tone,
  empty,
  chips,
  footnote,
}: {
  title: string;
  icon: typeof Plus;
  tone: "emerald" | "rose";
  empty: string;
  chips: TokenChip[];
  footnote?: string;
}) {
  const t = TONE[tone];
  return (
    <div className="rounded-lg border bg-card/40 p-3">
      <div className={cn("flex items-center gap-1.5 text-xs font-semibold", t.head)}>
        <Icon className="size-3.5" />
        {title}
        <span className="ml-auto text-[10px] font-normal text-muted-foreground">
          {chips.length}
        </span>
      </div>
      <div className="mt-2">
        {chips.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{empty}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <Badge
                key={c.token}
                variant="outline"
                title={c.token}
                className={cn("max-w-full gap-1 font-normal", t.badge)}
              >
                <span className="truncate">{c.label}</span>
                {c.sticky && (
                  <span className="shrink-0 text-[9px] opacity-80">sticky</span>
                )}
              </Badge>
            ))}
          </div>
        )}
      </div>
      {footnote && (
        <p className="mt-2 text-[10px] leading-snug text-muted-foreground/80">
          {footnote}
        </p>
      )}
    </div>
  );
}

function DiffRow({
  label,
  tone,
  tokens,
}: {
  label: string;
  tone: "emerald" | "rose" | "muted";
  tokens: string[];
}) {
  if (tokens.length === 0) return null;
  const t = TONE[tone];
  return (
    <div className="space-y-1.5">
      <div className={cn("text-xs font-semibold", t.head)}>
        {label} ({tokens.length})
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tokens
          .slice()
          .sort((a, b) =>
            sortChips(
              { token: a, label: describeToken(a).label, sticky: false },
              { token: b, label: describeToken(b).label, sticky: false },
            ),
          )
          .map((tok) => (
            <Badge
              key={tok}
              variant="outline"
              title={tok}
              className={cn("max-w-full gap-1 font-normal", t.badge)}
            >
              <span className="truncate">{describeToken(tok).label}</span>
            </Badge>
          ))}
      </div>
    </div>
  );
}
