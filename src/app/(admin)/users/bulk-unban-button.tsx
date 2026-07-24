"use client";

/**
 * Self-contained bulk-unban dialog for /users — the counterpart to
 * bulk-ban-button.tsx and the way back out of a bad sweep.
 *
 * It exists because the bulk ban shipped before the creator carve-out did,
 * so a sweep run in that window could have caught creators and ex-creators.
 * "Creators & past creators" (or the wider "protected accounts") re-checks
 * every banned account against today's rules and releases the ones that
 * should never have been banned.
 *
 * Unlike the ban dialog this previews WHO, not just how many — the whole
 * point is verifying the filter found the right cohort before acting, and a
 * bare count can't show that.
 *
 * Admin/owner only. The parent decides whether to render it and BOTH server
 * actions re-check, because a render gate is not a security boundary.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatRelative } from "@/lib/utils/format";
import { bulkUnbanFilteredUsers, previewBulkUnban } from "./actions";

/** Typed verbatim to arm the unban — a deliberate speed bump. */
const CONFIRM_PHRASE = "UNBAN";
/** Sentinel for "no preference" — Select can't hold undefined. */
const ANY = "__any";
/** Mirrors BULK_BAN_MAX server-side; display only, the server enforces it. */
const MAX_DISPLAY = 25_000;

type PreviewUser = {
  id: string;
  username: string | null;
  email: string | null;
  role: string;
  bannedReason: string | null;
  bannedAt: string | null;
  isProtected: boolean;
};

type Criteria = {
  accountType?: string;
  bannedWithinDays?: string;
  deposited?: string;
  provider?: string;
};

const SELECT_FIELDS: Array<{
  key: keyof Criteria;
  label: string;
  hint?: string;
  options: Array<{ value: string; label: string }>;
}> = [
  {
    key: "accountType",
    label: "Account type",
    hint: "Creators and past creators can no longer be bulk-banned — this finds the ones banned before that rule existed.",
    options: [
      { value: "protected", label: "Any protected account (creators, past creators, staff)" },
      { value: "creator", label: "Creators & past creators" },
      { value: "staff", label: "Staff (admin / support)" },
      { value: "player", label: "Plain players only" },
    ],
  },
  {
    key: "bannedWithinDays",
    label: "Banned within",
    hint: "Bans with no recorded date are skipped when a window is set.",
    options: [
      { value: "1", label: "Last 24 hours" },
      { value: "7", label: "Last 7 days" },
      { value: "30", label: "Last 30 days" },
      { value: "90", label: "Last 90 days" },
    ],
  },
  {
    key: "deposited",
    label: "Deposited",
    options: [
      { value: "yes", label: "Has deposited" },
      { value: "no", label: "Never deposited" },
    ],
  },
  {
    key: "provider",
    label: "Signed up with",
    options: [
      { value: "discord", label: "Discord" },
      { value: "google", label: "Google" },
      { value: "steam", label: "Steam" },
      { value: "credential", label: "Email + password" },
    ],
  },
];

function roleBadgeClass(role: string): string {
  if (role === "creator")
    return "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30";
  if (role === "admin" || role === "support")
    return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30";
  return "bg-muted text-muted-foreground border-border";
}

export function BulkUnbanButton() {
  const [open, setOpen] = useState(false);
  const [criteria, setCriteria] = useState<Criteria>({});
  const [count, setCount] = useState<number | null>(null);
  const [capped, setCapped] = useState(false);
  const [sample, setSample] = useState<PreviewUser[]>([]);
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState("");
  const [counting, startCount] = useTransition();
  const [unbanning, startUnban] = useTransition();
  const router = useRouter();

  const busy = counting || unbanning;
  const activeCount = Object.values(criteria).filter(Boolean).length;

  const reset = () => {
    setCriteria({});
    setCount(null);
    setCapped(false);
    setSample([]);
    setNote("");
    setConfirm("");
  };

  /** Any criteria edit invalidates the preview, so a stale count can never
   *  be the number that gets unbanned. The server re-checks it too. */
  const invalidate = () => {
    setCount(null);
    setCapped(false);
    setSample([]);
    setConfirm("");
  };

  const setField = (key: keyof Criteria, value: string) => {
    setCriteria((prev) => ({
      ...prev,
      [key]: value === ANY ? undefined : value,
    }));
    invalidate();
  };

  /** Shape the dialog state into the server action's filter payload. */
  const filters = () => ({
    accountType: criteria.accountType,
    bannedWithinDays: criteria.bannedWithinDays
      ? Number(criteria.bannedWithinDays)
      : undefined,
    deposited: criteria.deposited,
    provider: criteria.provider,
  });

  const preview = () => {
    startCount(async () => {
      const result = await previewBulkUnban(filters());
      if (!result.success) {
        toast.error(result.error);
        setCount(null);
        setSample([]);
        return;
      }
      setCount(result.data.count);
      setCapped(result.data.capped);
      setSample(result.data.sample);
    });
  };

  const armed =
    count !== null &&
    count > 0 &&
    !capped &&
    confirm === CONFIRM_PHRASE &&
    !busy;

  const submit = () => {
    if (!armed || count === null) return;
    startUnban(async () => {
      const result = await bulkUnbanFilteredUsers({
        filters: filters(),
        note: note.trim() || undefined,
        expectedCount: count,
      });
      if (!result.success) {
        toast.error(result.error);
        // Most likely the matching set moved — force a fresh preview.
        invalidate();
        return;
      }
      toast.success(
        `Unbanned ${result.data.unbannedCount.toLocaleString()} account${
          result.data.unbannedCount === 1 ? "" : "s"
        }.`,
      );
      setOpen(false);
      reset();
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      {/* Base UI (not Radix): Trigger renders its own <button>, so styles go
          straight on it — there is no `asChild`. */}
      <DialogTrigger className="inline-flex h-9 items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-emerald-400">
        <ShieldCheck className="size-3.5" />
        Review bans
      </DialogTrigger>

      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-emerald-500" />
          Review bans & unban
        </DialogTitle>
        <DialogDescription>
          Re-check banned accounts and release the ones that shouldn&apos;t
          have been caught. Only already-banned accounts are ever touched.
        </DialogDescription>

        <div className="space-y-3">
          {SELECT_FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={`unban-${f.key}`}>{f.label}</Label>
              <Select
                value={criteria[f.key] ?? ANY}
                onValueChange={(v) => setField(f.key, v ?? ANY)}
              >
                <SelectTrigger id={`unban-${f.key}`}>
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any</SelectItem>
                  {f.options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {f.hint && (
                <p className="text-xs text-muted-foreground">{f.hint}</p>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 p-3">
          <button
            type="button"
            onClick={preview}
            disabled={activeCount === 0 || busy}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {counting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Search className="size-3.5" />
            )}
            Preview
          </button>
          <div className="min-w-0 text-xs">
            {activeCount === 0 ? (
              <span className="text-muted-foreground">
                Select at least one criterion.
              </span>
            ) : count === null ? (
              <span className="text-muted-foreground">
                Preview to see which banned accounts match.
              </span>
            ) : capped ? (
              <span className="text-rose-500">
                Over the {MAX_DISPLAY.toLocaleString()} limit — narrow it down.
              </span>
            ) : (
              <span className="font-medium">
                {count.toLocaleString()} banned account
                {count === 1 ? "" : "s"} match
              </span>
            )}
          </div>
        </div>

        {sample.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {count !== null && count > sample.length
                ? `Showing ${sample.length} of ${count.toLocaleString()}:`
                : "Matching accounts:"}
            </p>
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {sample.map((u) => (
                <div
                  key={u.id}
                  className="flex items-start justify-between gap-3 rounded px-1.5 py-1 text-xs hover:bg-muted/50"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">
                        {u.username ?? u.email ?? u.id}
                      </span>
                      <span
                        className={`shrink-0 rounded border px-1 py-px text-[10px] ${roleBadgeClass(u.role)}`}
                      >
                        {u.role}
                      </span>
                      {u.isProtected && u.role === "user" && (
                        <span className="shrink-0 rounded border border-purple-500/30 bg-purple-500/15 px-1 py-px text-[10px] text-purple-600 dark:text-purple-400">
                          past creator
                        </span>
                      )}
                    </div>
                    <p className="truncate text-muted-foreground">
                      {u.bannedReason ?? "no reason recorded"}
                    </p>
                  </div>
                  {u.bannedAt && (
                    <span className="shrink-0 text-muted-foreground">
                      {formatRelative(new Date(u.bannedAt))}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="unban-note">Note (optional)</Label>
          <Input
            id="unban-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="false positives from the signup-farm sweep"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Kept in the audit trail alongside each account&apos;s original ban
            reason — unbanning clears that reason from the account itself.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="unban-confirm">
            Type <span className="font-mono">{CONFIRM_PHRASE}</span> to confirm
          </Label>
          <Input
            id="unban-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
            disabled={count === null || count === 0 || capped}
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="h-9 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!armed}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {unbanning && <Loader2 className="size-3.5 animate-spin" />}
            {unbanning
              ? "Unbanning…"
              : count === null
                ? "Unban"
                : `Unban ${count.toLocaleString()}`}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
