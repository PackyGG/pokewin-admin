"use client";

/**
 * Self-contained bulk-ban dialog for /users. Criteria are picked INSIDE the
 * popup — it does not read the page's URL filters, so the audit flow is one
 * entry point rather than "set the list up first, then find the button".
 *
 * Admin/owner only. The parent decides whether to render it and BOTH server
 * actions re-check, because a render gate is not a security boundary.
 *
 * There is no delete counterpart, by design: deleting would orphan ledger
 * rows, break the hash-chained audit trail, and null out `fingerprints.user_id`
 * — destroying the alt-detection evidence that justifies the ban. Ban is
 * reversible; delete is not.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Loader2, Search } from "lucide-react";
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
import { BAN_REASON_PRESETS } from "@/lib/ban-reasons";
import { bulkBanFilteredUsers, previewBulkBanCount } from "./actions";

/** Typed verbatim to arm the ban — a deliberate speed bump. */
const CONFIRM_PHRASE = "BAN";
/** Sentinel for "no preference" — Select can't hold undefined. */
const ANY = "__any";
/** Mirrors BULK_BAN_MAX server-side; display only, the server enforces it. */
const MAX_DISPLAY = 25_000;

type Criteria = {
  deposited?: string;
  provider?: string;
  sharedIp?: string;
  sharedDevice?: string;
  freeOnly?: string;
  status?: string;
};

const FIELDS: Array<{
  key: keyof Criteria;
  label: string;
  hint?: string;
  options: Array<{ value: string; label: string }>;
}> = [
  {
    key: "freeOnly",
    label: "Claimed free value, never deposited",
    hint: "The farming shape — took a payout and never paid in.",
    options: [
      { value: "reward", label: "Reward pack, no deposit" },
      { value: "rain", label: "Rain, no deposit" },
    ],
  },
  {
    key: "sharedIp",
    label: "Signup IP",
    options: [
      { value: "yes", label: "Shared with other accounts" },
      { value: "no", label: "Unique to this account" },
    ],
  },
  {
    key: "sharedDevice",
    label: "Device",
    hint: "Fingerprint capture started 2026-07-22 — near-empty for older accounts.",
    options: [{ value: "yes", label: "Shared with other accounts" }],
  },
  {
    key: "deposited",
    label: "Deposited",
    options: [
      { value: "no", label: "Never deposited" },
      { value: "yes", label: "Has deposited" },
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
  {
    key: "status",
    label: "Status",
    hint: "Already-banned accounts are skipped regardless.",
    options: [
      { value: "active", label: "Active" },
      { value: "locked", label: "Locked" },
    ],
  },
];

export function BulkBanButton() {
  const [open, setOpen] = useState(false);
  const [criteria, setCriteria] = useState<Criteria>({});
  const [count, setCount] = useState<number | null>(null);
  const [capped, setCapped] = useState(false);
  const [reasonOption, setReasonOption] = useState<string | null>(null);
  const [customReason, setCustomReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [counting, startCount] = useTransition();
  const [banning, startBan] = useTransition();
  const router = useRouter();

  const activeCount = Object.values(criteria).filter(Boolean).length;
  const busy = counting || banning;

  const reset = () => {
    setCriteria({});
    setCount(null);
    setCapped(false);
    setReasonOption(null);
    setCustomReason("");
    setConfirm("");
  };

  /**
   * Any criteria edit invalidates the preview, so a stale count can never be
   * the number that gets banned. The server independently re-checks it too.
   */
  const setField = (key: keyof Criteria, value: string) => {
    setCriteria((prev) => ({
      ...prev,
      [key]: value === ANY ? undefined : value,
    }));
    setCount(null);
    setCapped(false);
    setConfirm("");
  };

  const preview = () => {
    startCount(async () => {
      const result = await previewBulkBanCount(criteria);
      if (!result.success) {
        toast.error(result.error);
        setCount(null);
        return;
      }
      setCount(result.data.count);
      setCapped(result.data.capped);
    });
  };

  const isCustomReason = reasonOption === "custom";
  const effectiveReason = isCustomReason
    ? customReason.trim()
    : (reasonOption ?? "");

  const armed =
    count !== null &&
    count > 0 &&
    !capped &&
    effectiveReason.length > 0 &&
    confirm === CONFIRM_PHRASE &&
    !busy;

  const submit = () => {
    if (!armed || count === null) return;
    startBan(async () => {
      const result = await bulkBanFilteredUsers({
        filters: criteria,
        reason: effectiveReason,
        expectedCount: count,
      });
      if (!result.success) {
        toast.error(result.error);
        // Most likely the matching set moved — force a fresh preview.
        setCount(null);
        setConfirm("");
        return;
      }
      toast.success(
        `Banned ${result.data.bannedCount.toLocaleString()} account${
          result.data.bannedCount === 1 ? "" : "s"
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
      <DialogTrigger className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 text-xs font-medium text-rose-600 transition-colors hover:bg-rose-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-rose-400">
        <Ban className="size-3.5" />
        Bulk ban
      </DialogTrigger>

      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogTitle className="flex items-center gap-2">
          <Ban className="size-4 text-rose-500" />
          Bulk ban
        </DialogTitle>
        <DialogDescription>
          Pick criteria, preview how many accounts match, then ban them. Only
          plain player accounts are ever targeted — admins, support, creators,
          past creators and already-banned accounts are always skipped. Nothing
          is deleted — this is reversible.
        </DialogDescription>

        <div className="space-y-3">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={`bulk-${f.key}`}>{f.label}</Label>
              <Select
                value={criteria[f.key] ?? ANY}
                onValueChange={(v) => setField(f.key, v ?? ANY)}
              >
                <SelectTrigger id={`bulk-${f.key}`}>
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
                Preview to see how many accounts match.
              </span>
            ) : capped ? (
              <span className="text-rose-500">
                Over the {MAX_DISPLAY.toLocaleString()} limit — narrow it down.
              </span>
            ) : (
              <span className="font-medium">
                {count.toLocaleString()} account{count === 1 ? "" : "s"} match
              </span>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="bulk-ban-reason">Reason</Label>
          <Select
            value={reasonOption ?? undefined}
            onValueChange={setReasonOption}
          >
            <SelectTrigger id="bulk-ban-reason">
              <SelectValue placeholder="Select a reason" />
            </SelectTrigger>
            <SelectContent>
              {BAN_REASON_PRESETS.map((reason) => (
                <SelectItem key={reason} value={reason}>
                  {reason}
                </SelectItem>
              ))}
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
          {isCustomReason && (
            <Input
              value={customReason}
              onChange={(event) => setCustomReason(event.target.value)}
              placeholder="bulk:signup-farm-2026-06-12"
              autoComplete="off"
              autoFocus
            />
          )}
          <p className="text-xs text-muted-foreground">
            Stored on every account — make it a marker you can search and undo
            by later.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="bulk-ban-confirm">
            Type <span className="font-mono">{CONFIRM_PHRASE}</span> to confirm
          </Label>
          <Input
            id="bulk-ban-confirm"
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
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-rose-600 px-3 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {banning && <Loader2 className="size-3.5 animate-spin" />}
            {banning
              ? "Banning…"
              : count === null
                ? "Ban"
                : `Ban ${count.toLocaleString()}`}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
