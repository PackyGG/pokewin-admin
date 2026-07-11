"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDownToLine, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { ROLES } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils/format";
import { parseUsdAmount } from "@/lib/utils/money";
import {
  SELECTABLE_ADJUSTMENT_CATEGORY_KEYS,
  BALANCE_ADJUSTMENT_CATEGORY_META,
  BUGS_ADJUSTMENT_MIN_REASON_CHARS,
  REMOVE_LOCKED_BALANCE_MIN_REASON_CHARS,
  FRAUD_ABUSE_MIN_REASON_CHARS,
  isRemovalOnlyAdjustmentCategory,
  isCreatorLinkedAdjustmentCategory,
  isCountedAdjustmentCategory,
  type BalanceAdjustmentCategory,
} from "@/lib/balance-adjustment-categories";
import { CreatorLinkPicker } from "./creator-link-picker";
import { DepositBonusCalculator } from "./deposit-bonus-calculator";
import {
  adjustBalance,
  adjustXp,
  changeRole,
  forceResetCreatorToUser,
  recordManualWithdrawal,
  setUserTag,
} from "./actions";

// Balance-adjust categories OFFERED IN THE PICKER — the strict, canonical
// SELECTABLE set. Each option's `value` is written to the ledger row's
// `metadata.adjustment_category` (single source of truth in
// `@/lib/balance-adjustment-categories`) and drives the conditional inputs
// below. The credit categories are counted in GGR/NGR/cost; the
// removal-only `leaderboard` debit is NOT counted and is gated to the
// remove-balance direction at render time (see `visibleCategories` below).
// (`Challenge`, `Streamer` and `Other` were removed from the picker —
// `Other` stays a valid stored category for back-compat display of
// existing records, it's just no longer selectable here.)
const BALANCE_ADJUST_CATEGORIES = SELECTABLE_ADJUSTMENT_CATEGORY_KEYS.map(
  (key) => ({
    value: key,
    label: BALANCE_ADJUSTMENT_CATEGORY_META[key].label,
    removalOnly: isRemovalOnlyAdjustmentCategory(key),
  }),
);

// The categories offered on the dialog's "VIP" tab — comp-style credits only.
// Every other selectable category stays on the "Normal" tab. Purely a
// display-side filter over `BALANCE_ADJUST_CATEGORIES`; the underlying
// category state and the conditional inputs below are unchanged.
const VIP_TAB_CATEGORY_KEYS: BalanceAdjustmentCategory[] = [
  "bonus",
  "deposit_bonus",
  "lossback",
];

// Lossback quick-pick rates + the hard cap on any custom rate. The cap is
// mirrored server-side in `validateAdjustmentCategory` (actions.ts) — keep
// the two in sync.
const LOSSBACK_QUICK_PERCENTS = [5, 10, 15, 20] as const;
const LOSSBACK_MAX_PERCENT = 35;

export function BalanceAdjustDialog({
  userId,
  availableBalance,
  availableBalanceRaw,
  lockedBalance,
  pnl7d,
  open,
  onOpenChange,
}: {
  userId: string;
  // Current on-site cash balance, used only for the live "resulting
  // balance" preview. Optional so existing call sites that don't have it
  // still render (the preview just omits the resulting-balance line).
  availableBalance?: number;
  // The RAW spendable balance the server actually debits (the displayed
  // `availableBalance` can be inflated by official-stream credits that
  // aren't real cash). The preview + negative check use THIS so the dialog
  // never promises a removal the server will reject. Falls back to
  // `availableBalance` when not supplied.
  availableBalanceRaw?: number;
  // Current locked (vault) balance — used for the remove_locked_balance
  // category preview. Optional for legacy call sites.
  lockedBalance?: number;
  // The user's rolling 7-day house P&L — the SAME derived value the
  // Accounts tab shows (`pnlBreakdown.pnl7d`, computed once on the server
  // via `getUserWindowedPnlMulti`). Passed in as a plain number so the
  // Lossback section can auto-fill it instead of asking the admin to
  // re-type it (no drift vs the Accounts tab). Optional: legacy call sites
  // that don't have the breakdown in scope fall back to a manual input.
  pnl7d?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [amount, setAmount] = useState("");
  // Category picker tab — Normal (everything else) vs VIP (bonus,
  // deposit_bonus, lossback only). Purely a display filter over
  // `BALANCE_ADJUST_CATEGORIES`; the underlying `category` state and every
  // conditional input below it are unchanged and rendered once.
  const [adjustTab, setAdjustTab] = useState<"normal" | "vip">("normal");
  // The strict category drives the conditional inputs + counting.
  const [category, setCategory] = useState<BalanceAdjustmentCategory | "">("");
  // deposit_problem
  const [coinType, setCoinType] = useState("");
  const [txHash, setTxHash] = useState("");
  // giveaway
  const [socialLink, setSocialLink] = useState("");
  // bonus (≥20 chars) / bugs (≥30 chars) / other (≥20 chars) / lossback note
  const [reasonText, setReasonText] = useState("");
  // leaderboard (removal-only) — the linked creator. `{ id, label }` so the
  // trigger can show the chosen creator without re-fetching.
  const [creatorLink, setCreatorLink] = useState<
    { id: string; label: string } | null
  >(null);
  // lossback
  const [lossbackPercent, setLossbackPercent] = useState("");
  // Only used as a manual fallback when the derived `pnl7d` isn't supplied
  // (legacy call sites). When `pnl7d` is provided, the 7d PnL is read-only
  // and this state is unused.
  const [pnl7dManual, setPnl7dManual] = useState("");
  const [totpCode, setTotpCode] = useState("");
  // Optional: also apply the Wager Abuser profile tag together with this
  // adjustment (separate from the balance-adjustment category — this is the
  // persistent user-profile flag surfaced on the Tags panel + Creator Hub
  // Wager Abusers page).
  const [tagWagerAbuser, setTagWagerAbuser] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Whether the 7d PnL is auto-supplied (derived, read-only) vs typed in.
  const hasDerivedPnl7d = pnl7d !== undefined;
  // The effective 7d-PnL string sent to the action: the derived value when
  // present, else whatever the admin typed in the manual fallback.
  const pnl7dValue = hasDerivedPnl7d ? String(pnl7d) : pnl7dManual;

  function resetFields() {
    setAmount("");
    setCategory("");
    setCoinType("");
    setTxHash("");
    setSocialLink("");
    setReasonText("");
    setCreatorLink(null);
    setLossbackPercent("");
    setPnl7dManual("");
    setTotpCode("");
    setTagWagerAbuser(false);
    setAdjustTab("normal");
  }

  // The human-readable description text sent as `reason` (kept so the
  // existing description-prefix classification on the insights surface +
  // the adjustments-wipe flow keep working). The category-specific note is
  // appended when it adds signal beyond the category label.
  function resolveReason(cat: BalanceAdjustmentCategory): string {
    const label = BALANCE_ADJUSTMENT_CATEGORY_META[cat].label;
    if (
      cat === "bonus" ||
      cat === "bugs" ||
      cat === "other" ||
      cat === "remove_locked_balance" ||
      cat === "fraud_abuse" ||
      cat === "withdrawal_failed"
    ) {
      const t = reasonText.trim();
      return t.length > 0 ? `${label}: ${t}` : label;
    }
    // deposit_bonus: reasonText is the auto-generated "5% of $X (N deposits)"
    // line from the calculator (or empty when the admin just typed an amount).
    if (cat === "deposit_bonus") {
      const t = reasonText.trim();
      return t.length > 0 ? t : label;
    }
    return label;
  }

  function handleAdjust() {
    // Robust parse — never silently truncates a malformed thousands
    // amount (e.g. "17.878.54") the way parseFloat did. Rejected input
    // surfaces the parser's message instead of writing a wrong ledger row.
    const parsedAmount = parseUsdAmount(amount);
    if (!parsedAmount.ok) {
      toast.error(parsedAmount.error);
      return;
    }
    const numAmount = parsedAmount.value;
    if (numAmount === 0) {
      toast.error("Amount can't be zero");
      return;
    }
    if (!category) {
      toast.error("Please pick a category");
      return;
    }
    // Removal-only categories ALWAYS subtract — the admin types a positive
    // amount to remove and we send it as a debit. Computed here so the same
    // value flows into both the validation below and the action call.
    const finalAmount = isRemovalOnlyAdjustmentCategory(category)
      ? -Math.abs(numAmount)
      : numAmount;
    // Client-side mirror of the server's per-category required-input rules
    // (the server re-validates — this is just a friendlier inline toast).
    if (category === "deposit_problem") {
      if (!coinType.trim()) return void toast.error("Deposit problem needs a coin type");
      if (!txHash.trim()) return void toast.error("Deposit problem needs a transaction hash");
    } else if (category === "giveaway") {
      if (!socialLink.trim()) return void toast.error("Giveaway needs a Twitter or Discord link");
    } else if (category === "bonus") {
      if (reasonText.trim().length < 20) return void toast.error("Bonus needs an exact reason (min 20 chars)");
    } else if (category === "bugs") {
      if (reasonText.trim().length < BUGS_ADJUSTMENT_MIN_REASON_CHARS) {
        return void toast.error(
          `Bugs needs an explanation (min ${BUGS_ADJUSTMENT_MIN_REASON_CHARS} chars)`,
        );
      }
    } else if (category === "lossback") {
      if (!pnl7dValue.trim()) return void toast.error("Lossback needs a 7-day PnL value");
      if (!lossbackPercent.trim()) return void toast.error("Lossback needs a lossback %");
    } else if (category === "leaderboard") {
      // Removal-only — amount is auto-negated above. Only the linked
      // creator is required here.
      if (!creatorLink) {
        return void toast.error("Pick the creator to link this leaderboard adjustment to");
      }
    } else if (category === "remove_locked_balance") {
      if (reasonText.trim().length < REMOVE_LOCKED_BALANCE_MIN_REASON_CHARS) {
        return void toast.error(
          `Remove locked balance needs a reason (min ${REMOVE_LOCKED_BALANCE_MIN_REASON_CHARS} chars)`,
        );
      }
    } else if (category === "fraud_abuse") {
      if (reasonText.trim().length < FRAUD_ABUSE_MIN_REASON_CHARS) {
        return void toast.error(
          `Fraud / abuse needs an explanation (min ${FRAUD_ABUSE_MIN_REASON_CHARS} chars)`,
        );
      }
    } else if (category === "official_stream") {
      // Creator-linked, but NOT removal-only: both add + remove are
      // allowed. Only the linked creator is required. The server
      // re-checks this; the inline toast is just friendlier.
      if (!creatorLink) {
        return void toast.error("Pick the creator to link this official-stream adjustment to");
      }
    } else if (category === "other") {
      if (reasonText.trim().length < 20) return void toast.error("Other needs a reason (min 20 chars)");
    }
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }

    // Parse the numeric lossback inputs from the free-text fields. Both are
    // validated above for presence; here we coerce + reject non-numbers.
    let lossbackPercentNum: number | undefined;
    let pnl7dNum: number | undefined;
    if (category === "lossback") {
      lossbackPercentNum = Number(lossbackPercent.trim());
      pnl7dNum = Number(pnl7dValue.trim());
      if (!Number.isFinite(lossbackPercentNum)) return void toast.error("Lossback % must be a number");
      if (!Number.isFinite(pnl7dNum)) return void toast.error("7-day PnL must be a number");
      // Mirror the server cap (0–35%) for a friendlier inline toast.
      if (lossbackPercentNum < 0 || lossbackPercentNum > LOSSBACK_MAX_PERCENT) {
        return void toast.error(`Lossback % must be between 0 and ${LOSSBACK_MAX_PERCENT}`);
      }
    }

    startTransition(async () => {
      try {
        const result = await adjustBalance({
          userId,
          amount: finalAmount,
          category,
          reason: resolveReason(category),
          totpCode: totpCode.trim(),
          details: {
            coinType: category === "deposit_problem" ? coinType.trim() : undefined,
            txHash: category === "deposit_problem" ? txHash.trim() : undefined,
            socialLink: category === "giveaway" ? socialLink.trim() : undefined,
            reasonText:
              category === "bonus" ||
              category === "bugs" ||
              category === "other" ||
              category === "remove_locked_balance" ||
              category === "fraud_abuse" ||
              category === "lossback" ||
              category === "deposit_bonus" ||
              category === "withdrawal_failed"
                ? reasonText.trim() || undefined
                : undefined,
            lossbackPercent: lossbackPercentNum,
            pnl7dUsd: pnl7dNum,
            creatorId: isCreatorLinkedAdjustmentCategory(category)
              ? creatorLink?.id
              : undefined,
          },
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Balance adjusted");

        // Optionally apply the persistent abuser profile tag(s) alongside
        // the adjustment. Tagging failures are non-fatal — the balance
        // change already succeeded, so we surface a soft warning instead of
        // rolling anything back.
        const tagsToApply: "wager_abuser"[] = [];
        if (tagWagerAbuser) tagsToApply.push("wager_abuser");
        for (const t of tagsToApply) {
          const tagResult = await setUserTag(userId, t);
          if (!tagResult.success) {
            toast.warning(`Adjusted, but couldn't tag: ${tagResult.error}`);
          }
        }

        resetFields();
        onOpenChange(false);
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to adjust balance",
        );
      }
    });
  }

  // Live parse of whatever the admin has typed so far. Drives the preview
  // line below + gates the submit button, so a misparse (or zero) is
  // visible BEFORE confirming — the same parser the submit handler uses.
  const trimmedAmount = amount.trim();
  const parsedPreview = parseUsdAmount(amount);
  const rawPreviewValue = parsedPreview.ok ? parsedPreview.value : null;
  // Removal-only categories (Remove locked balance, Fraud / abuse,
  // Leaderboard) ALWAYS subtract: the admin types the amount to remove as a
  // plain positive number (e.g. 50) and we treat it as a debit. They can
  // still type -50 and it behaves the same. This removes the old "you must
  // type a negative amount" trap that made removals look broken.
  const isRemovalCategory =
    !!category && isRemovalOnlyAdjustmentCategory(category);
  const previewValue =
    rawPreviewValue === null
      ? null
      : isRemovalCategory
        ? -Math.abs(rawPreviewValue)
        : rawPreviewValue;
  const isAmountValid = previewValue !== null && previewValue !== 0;
  // Direction label from the effective sign (explicit add vs remove).
  const isRemoval = previewValue !== null && previewValue < 0;
  const affectsLockedPreview = category === "remove_locked_balance";
  // The server debits the RAW available column, which can be lower than the
  // displayed (official-stream-netted) cash. Preview against the raw value
  // so a removal the server would reject shows as negative HERE first.
  const spendableBalance =
    availableBalanceRaw ?? availableBalance;
  const newBalance =
    previewValue !== null &&
    !affectsLockedPreview &&
    spendableBalance !== undefined
      ? spendableBalance + previewValue
      : null;
  // True when the shown cash is inflated by non-removable balance (e.g.
  // official-stream credit): a removal can only touch the raw spendable
  // amount, so warn the admin when the two diverge meaningfully.
  const hasInflatedDisplay =
    availableBalance !== undefined &&
    availableBalanceRaw !== undefined &&
    availableBalanceRaw < availableBalance - 0.01;
  const newLockedBalance =
    previewValue !== null &&
    affectsLockedPreview &&
    lockedBalance !== undefined
      ? lockedBalance + previewValue
      : null;

  // Every selectable category is always offered — removal-only categories
  // (Remove locked balance, Fraud / abuse, Leaderboard) used to be HIDDEN
  // until the admin typed a negative amount, which made them look missing.
  // The Normal/VIP tab above additionally filters WHICH categories show:
  // the VIP tab surfaces only the comp-style credits (bonus, deposit_bonus,
  // lossback); Normal surfaces everything else.
  const visibleCategories = BALANCE_ADJUST_CATEGORIES.filter((r) =>
    adjustTab === "vip"
      ? VIP_TAB_CATEGORY_KEYS.includes(r.value)
      : !VIP_TAB_CATEGORY_KEYS.includes(r.value),
  );

  // ── Lossback derivations (house POV) ──────────────────────────────
  // `pnl7d` is the rolling 7-day house P&L: POSITIVE = the house gained =
  // the user LOST that much over the window; NEGATIVE = the house is down
  // (the user is up) so there's no loss to rebate. The user's 7d loss is
  // therefore `max(0, pnl7d)`. A lossback credits back a % of that loss.
  const pnl7dNumPreview = hasDerivedPnl7d
    ? (pnl7d as number)
    : Number(pnl7dManual.trim());
  const hasPnl7dPreview =
    hasDerivedPnl7d || (pnl7dManual.trim().length > 0 && Number.isFinite(pnl7dNumPreview));
  const user7dLoss =
    hasPnl7dPreview && Number.isFinite(pnl7dNumPreview)
      ? Math.max(0, pnl7dNumPreview)
      : 0;
  const lossbackPercentPreview = Number(lossbackPercent.trim());
  const lossbackPercentValid =
    lossbackPercent.trim().length > 0 &&
    Number.isFinite(lossbackPercentPreview) &&
    lossbackPercentPreview >= 0 &&
    lossbackPercentPreview <= LOSSBACK_MAX_PERCENT;
  const lossbackPercentOver =
    lossbackPercent.trim().length > 0 &&
    Number.isFinite(lossbackPercentPreview) &&
    lossbackPercentPreview > LOSSBACK_MAX_PERCENT;
  // Suggested credit = % × the user's 7d loss. Only meaningful when both
  // the rate is valid and the user actually lost over the window.
  const lossbackCredit =
    lossbackPercentValid && user7dLoss > 0
      ? (lossbackPercentPreview / 100) * user7dLoss
      : null;

  // Sets the lossback % AND auto-fills the adjustment Amount with the
  // computed credit = round(% × max(0, 7d loss), 2) — the same value the
  // suggested-credit line shows — so a quick-pick (or a typed custom %)
  // lands the ready-to-submit dollar figure in the Amount field (the admin
  // can still edit it). A valid 0–35% rate over a real loss fills the
  // rounded credit; no loss (user up/flat) fills 0 (the "no loss to rebate"
  // note still explains why submit is gated on a zero amount). An over-cap
  // value only updates the % so the cap warning shows — the stale Amount is
  // left untouched rather than written with a capped figure that fights the
  // admin's typing.
  function applyLossbackPercent(pct: string) {
    setLossbackPercent(pct);
    const pctNum = Number(pct.trim());
    if (
      pct.trim().length === 0 ||
      !Number.isFinite(pctNum) ||
      pctNum < 0 ||
      pctNum > LOSSBACK_MAX_PERCENT
    ) {
      return;
    }
    // user7dLoss is already max(0, pnl7d) from the derivations above.
    const credit = Math.round((pctNum / 100) * user7dLoss * 100) / 100;
    setAmount(credit.toFixed(2));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust Balance</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Amount</Label>
              {/* Quick-fill the exact removable cash for removal-only
                  categories so admins don't trip the "would go negative"
                  guard by entering more than the real spendable balance. */}
              {isRemovalCategory &&
                spendableBalance !== undefined &&
                spendableBalance > 0 && (
                  <button
                    type="button"
                    onClick={() => setAmount(String(spendableBalance))}
                    className="text-[10px] font-medium text-primary hover:underline"
                  >
                    Max removable {formatCurrency(spendableBalance)}
                  </button>
                )}
            </div>
            {/* text + inputMode="decimal" (not type="number") so commas and
                malformed multi-dot input reach the robust parser intact —
                a number input would silently drop them. */}
            <Input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="Amount (+/-), e.g. 17878.54 or -50"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {/* Live parsed-amount preview. Green/red follow the HOUSE POV:
                crediting the user (positive) = our liability = rose;
                removing from the user (negative) = our gain = emerald. */}
            {trimmedAmount.length > 0 &&
              (isAmountValid && previewValue !== null ? (
                <div className="rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">
                      {isRemoval
                        ? affectsLockedPreview
                          ? "Removing from locked"
                          : "Removing"
                        : "Adding"}
                    </span>
                    <span
                      className={`font-semibold tabular-nums ${
                        isRemoval
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400"
                      }`}
                    >
                      {isRemoval ? "−" : "+"}
                      {formatCurrency(Math.abs(previewValue))}
                    </span>
                  </div>
                  {newBalance !== null && (
                    <div className="mt-1 flex items-center justify-between gap-2 border-t pt-1">
                      <span className="text-muted-foreground">New cash balance</span>
                      <span
                        className={`font-semibold tabular-nums ${
                          newBalance < 0
                            ? "text-rose-600 dark:text-rose-400"
                            : ""
                        }`}
                      >
                        {formatCurrency(newBalance)}
                      </span>
                    </div>
                  )}
                  {newBalance !== null && newBalance < 0 && (
                    <p className="mt-1 text-[10px] text-rose-600 dark:text-rose-400">
                      Exceeds removable cash
                      {spendableBalance !== undefined
                        ? ` (max ${formatCurrency(spendableBalance)})`
                        : ""}{" "}
                      — the server will reject this.
                    </p>
                  )}
                  {newLockedBalance !== null && (
                    <div className="mt-1 flex items-center justify-between gap-2 border-t pt-1">
                      <span className="text-muted-foreground">New locked balance</span>
                      <span className="font-semibold tabular-nums">
                        {formatCurrency(newLockedBalance)}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-[11px] text-rose-600 dark:text-rose-400">
                  {parsedPreview.ok
                    ? "Amount can't be zero"
                    : parsedPreview.error}
                </p>
              ))}
            {hasInflatedDisplay && availableBalanceRaw !== undefined && (
              <p className="text-[10px] text-amber-600 dark:text-amber-400">
                Heads up: only {formatCurrency(availableBalanceRaw)} of this
                user&apos;s shown cash is real spendable balance (the rest is
                official-stream credit). Removals can&apos;t exceed that.
              </p>
            )}
          </div>
          <Tabs
            value={adjustTab}
            onValueChange={(v) => {
              const next = v as "normal" | "vip";
              setAdjustTab(next);
              // An old selection from the other tab can't linger invalid.
              setCategory("");
            }}
          >
            <TabsList variant="line">
              <TabsTrigger value="normal">Normal</TabsTrigger>
              <TabsTrigger value="vip">VIP</TabsTrigger>
            </TabsList>
            <TabsContent value="normal" keepMounted />
            <TabsContent value="vip" keepMounted />
          </Tabs>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Category</Label>
            <Select
              value={category}
              onValueChange={(v) => {
                if (!v) return;
                setCategory(v as BalanceAdjustmentCategory);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a category..." />
              </SelectTrigger>
              <SelectContent>
                {visibleCategories.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                    {r.removalOnly ? " (removes balance)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Removal-only categories always subtract — the admin types the
                amount to remove as a positive number. */}
            {isRemovalCategory && (
              <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                This category removes balance — enter the amount to remove
                (e.g. 50); it&apos;s deducted automatically.
              </p>
            )}

            {/* Deposit problem: coin type + on-chain tx hash. Recorded in
                the admin metadata table for the audit trail. */}
            {category === "deposit_problem" && (
              <div className="mt-2 space-y-2">
                <Input
                  placeholder="Coin (e.g. BTC, ETH, USDT)"
                  value={coinType}
                  onChange={(e) => setCoinType(e.target.value)}
                  autoComplete="off"
                />
                <Input
                  placeholder="Transaction hash"
                  value={txHash}
                  onChange={(e) => setTxHash(e.target.value)}
                  autoComplete="off"
                />
              </div>
            )}

            {/* Withdrawal failed: optional note — typically the failed
                withdrawal id or short reference. No minimum length: picking
                the category is the signal. */}
            {category === "withdrawal_failed" && (
              <div className="mt-2 space-y-1">
                <Textarea
                  placeholder="Optional — withdrawal id or short reference..."
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  rows={2}
                />
                <p className="text-[10px] text-muted-foreground">
                  Optional. Use this to refund a user after a declined /
                  failed withdrawal that wasn&apos;t auto-refunded.
                </p>
              </div>
            )}

            {/* Giveaway: a Twitter / X or Discord link. Server-side
                classifier accepts those hosts; the /marketing/giveaway
                feed shows where the giveaway came from. */}
            {category === "giveaway" && (
              <div className="mt-2 space-y-1">
                <Input
                  type="url"
                  inputMode="url"
                  placeholder="https://x.com/.../status/... or https://discord.com/channels/..."
                  value={socialLink}
                  onChange={(e) => setSocialLink(e.target.value)}
                  autoFocus
                />
                <p className="text-[10px] text-muted-foreground">
                  Link to the tweet or Discord message that advertised the
                  giveaway.
                </p>
              </div>
            )}

            {/* Bonus: exact reason, min 20 chars. */}
            {category === "bonus" && (
              <div className="mt-2 space-y-1">
                <Textarea
                  placeholder="Exact reason for this bonus (min 20 characters)..."
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  rows={2}
                />
                <p className="text-[10px] text-muted-foreground">
                  {reasonText.trim().length}/20 characters minimum.
                </p>
              </div>
            )}

            {/* Deposit bonus: OPTIONAL deposit picker + % calculator. The
                calculator auto-fills the Amount; the admin can also ignore it
                and just type an amount above. */}
            {category === "deposit_bonus" && userId && (
              <div className="mt-2">
                <DepositBonusCalculator
                  userId={userId}
                  onCompute={(computedAmount, computedReason) => {
                    setAmount(String(computedAmount));
                    setReasonText(computedReason);
                  }}
                  onClear={() => {
                    // Only clear the auto-filled reason; leave any amount the
                    // admin typed manually untouched.
                    setReasonText((prev) =>
                      prev.startsWith("Deposit bonus:") ? "" : prev,
                    );
                  }}
                />
              </div>
            )}

            {/* Bugs: detailed explanation, min 30 chars. */}
            {category === "bugs" && (
              <div className="mt-2 space-y-1">
                <Textarea
                  placeholder="Describe the bug and why this compensation is owed (min 30 characters)..."
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  rows={3}
                />
                <p className="text-[10px] text-muted-foreground">
                  {reasonText.trim().length}/{BUGS_ADJUSTMENT_MIN_REASON_CHARS}{" "}
                  characters minimum.
                </p>
              </div>
            )}

            {/* Lossback: auto-filled 7d PnL + % lossback (quick picks +
                custom, capped at 35%) + OPTIONAL note. */}
            {category === "lossback" && (
              <div className="mt-2 space-y-2.5">
                {/* 7-day PnL. Auto-filled read-only from the SAME derived
                    value the Accounts tab shows when supplied; manual
                    fallback only on legacy call sites without the
                    breakdown. House POV: pnl ≥ 0 = house gained (user
                    lost) = emerald; pnl < 0 = house down (user up) =
                    rose. */}
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">
                    7-day PnL (USD)
                  </Label>
                  {hasDerivedPnl7d ? (
                    <div className="rounded-md border bg-muted/30 px-2.5 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-muted-foreground">
                          Auto-filled · matches Accounts tab
                        </span>
                        <span
                          className={`text-sm font-semibold tabular-nums ${
                            (pnl7d as number) >= 0
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-rose-600 dark:text-rose-400"
                          }`}
                        >
                          {(pnl7d as number) >= 0 ? "+" : ""}
                          {formatCurrency(pnl7d as number)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder="e.g. -500"
                      value={pnl7dManual}
                      onChange={(e) => setPnl7dManual(e.target.value)}
                      autoComplete="off"
                    />
                  )}
                  {hasPnl7dPreview && (
                    <p className="text-[10px] text-muted-foreground">
                      {user7dLoss > 0 ? (
                        <>
                          User lost{" "}
                          <span className="font-semibold tabular-nums text-foreground">
                            {formatCurrency(user7dLoss)}
                          </span>{" "}
                          over the past 7 days.
                        </>
                      ) : (
                        "User is up (or flat) over the past 7 days — no loss to rebate."
                      )}
                    </p>
                  )}
                </div>

                {/* Lossback % — 4 quick picks + a custom box, capped at
                    35%. Clicking a pick sets the % directly. */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] text-muted-foreground">
                    Lossback %
                  </Label>
                  <div className="flex flex-wrap gap-1.5">
                    {LOSSBACK_QUICK_PERCENTS.map((p) => {
                      const active = lossbackPercentPreview === p;
                      return (
                        <Button
                          key={p}
                          type="button"
                          variant={active ? "default" : "outline"}
                          size="sm"
                          className="h-7 px-2.5 text-xs tabular-nums"
                          onClick={() => applyLossbackPercent(String(p))}
                        >
                          {p}%
                        </Button>
                      );
                    })}
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder="Custom"
                      value={lossbackPercent}
                      onChange={(e) => applyLossbackPercent(e.target.value)}
                      autoComplete="off"
                      aria-label="Custom lossback percent"
                      className="h-7 w-20 text-xs"
                    />
                  </div>
                  {lossbackPercentOver ? (
                    <p className="text-[10px] text-rose-600 dark:text-rose-400">
                      Max lossback is {LOSSBACK_MAX_PERCENT}%.
                    </p>
                  ) : (
                    <p className="text-[10px] text-muted-foreground">
                      Quick picks or a custom rate up to {LOSSBACK_MAX_PERCENT}%.
                    </p>
                  )}
                </div>

                {/* Suggested credit = % × the user's 7d loss. Rose =
                    crediting the user (our liability), per house POV. */}
                {lossbackCredit !== null && (
                  <div className="rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">
                        {lossbackPercentPreview}% of {formatCurrency(user7dLoss)}
                      </span>
                      <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                        +{formatCurrency(lossbackCredit)}
                      </span>
                    </div>
                  </div>
                )}

                <Textarea
                  placeholder="Optional explanation..."
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  rows={2}
                />
              </div>
            )}

            {/* Remove locked balance: detailed reason (min 20 chars). */}
            {category === "remove_locked_balance" && (
              <div className="mt-2 space-y-1">
                <Textarea
                  placeholder="Why is this locked balance being removed? (min 20 characters)..."
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  rows={3}
                />
                <p className="text-[10px] text-muted-foreground">
                  {reasonText.trim().length}/{REMOVE_LOCKED_BALANCE_MIN_REASON_CHARS}{" "}
                  characters minimum. Applies to vault / locked balance only — cash
                  balance is unchanged.
                </p>
              </div>
            )}

            {category === "fraud_abuse" && (
              <div className="mt-2 space-y-1">
                <Textarea
                  placeholder="Describe the fraud or abuse and why balance is being removed (min 20 characters)..."
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  rows={3}
                />
                <p className="text-[10px] text-muted-foreground">
                  {reasonText.trim().length}/{FRAUD_ABUSE_MIN_REASON_CHARS}{" "}
                  characters minimum. Removes from available balance only.
                </p>
              </div>
            )}

            {/* Creator-linked categories: link the creator this adjustment
                belongs to. Same searchable creator dropdown (search input
                pinned at the top) for every creator-linked category. The
                guard (not a hardcoded `leaderboard` check) drives this so a
                new creator-linked category renders the picker automatically.
                  • leaderboard → removal-only (only reachable when the
                    amount is negative; the option is hidden otherwise).
                  • official_stream → both add + remove allowed. */}
            {category && isCreatorLinkedAdjustmentCategory(category) && (
              <div className="mt-2 space-y-1">
                <CreatorLinkPicker
                  value={creatorLink}
                  onSelect={setCreatorLink}
                  disabled={isPending}
                />
                <p className="text-[10px] text-muted-foreground">
                  {category === "leaderboard"
                    ? "Removes balance from this user and links it to the selected creator. Search by username or email."
                    : "Links this balance adjustment to the selected creator's official stream. Search by username or email."}
                </p>
              </div>
            )}

            {/* Destructive warning for any UNCOUNTED category (e.g. `other`,
                `official_stream`): this amount is NOT tracked in GGR/PnL/cost.
                Gated on `!isCountedAdjustmentCategory` so any future uncounted
                category is auto-covered — mirrors the creator-link /
                removal-only guards above. */}
            {category && !isCountedAdjustmentCategory(category) && (
              <div className="mt-2 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-600 dark:text-rose-400">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  This amount will <span className="font-semibold">NOT</span>{" "}
                  be counted in GGR, P&amp;L or cost. Use it mainly for
                  content-creator bookkeeping — every other category is
                  tracked.
                </span>
              </div>
            )}

            {/* Other: free-text reason, min 20 chars (only `other` requires + stamps it). */}
            {category === "other" && (
              <div className="mt-2 space-y-2">
                <Textarea
                  placeholder="Reason (min 20 characters)..."
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  rows={2}
                />
                <p className="text-[10px] text-muted-foreground">
                  {reasonText.trim().length}/20 characters minimum.
                </p>
              </div>
            )}
          </div>
          {/* Optional persistent profile flag — applied alongside the
              adjustment. This is the SAME user-profile tag shown on the
              Tags panel + Creator Hub Wager Abusers page (not the
              balance-adjustment category). Toggle on to flag the user. */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Flag user (optional)
            </Label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setTagWagerAbuser((v) => !v)}
                className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                  tagWagerAbuser
                    ? "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                <ShieldAlert className="size-3.5" />
                Wager Abuser
              </button>
            </div>
            {tagWagerAbuser && (
              <p className="text-[10px] text-muted-foreground">
                Adds a permanent profile tag (also listed on Creator Hub →
                Wager Abusers). Remove it later from the user&apos;s Tags
                panel.
              </p>
            )}
          </div>
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
        </div>
        <DialogFooter>
          <Button
            size="sm"
            onClick={handleAdjust}
            disabled={isPending || !totpCode.trim() || !isAmountValid}
            className="w-full sm:w-auto"
          >
            {isPending ? "Adjusting..." : "Apply Adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Manual Withdrawal Dialog ──────────────────────────────────────
//
// Records an off-platform payout (admin paid the user via bank/crypto/etc.
// outside the standard withdrawal flow). Deducts on-site balance + bumps
// `total_withdrawn` so PnL stays correct.

const MANUAL_WITHDRAWAL_REASONS = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "crypto_send", label: "Crypto send" },
  { value: "paypal", label: "PayPal" },
  { value: "gift_card", label: "Gift card" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
] as const;

export function ManualWithdrawalDialog({
  userId,
  availableBalance,
  open,
  onOpenChange,
}: {
  userId: string;
  availableBalance: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [amount, setAmount] = useState("");
  const [reasonCategory, setReasonCategory] = useState<string>("");
  const [customReason, setCustomReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function resolveReason(): string {
    if (!reasonCategory) return "";
    if (reasonCategory === "other") return customReason.trim();
    const preset = MANUAL_WITHDRAWAL_REASONS.find(
      (r) => r.value === reasonCategory,
    );
    return preset?.label ?? reasonCategory;
  }

  function handleSubmit() {
    // Robust parse (same rule as Adjust Balance) — rejects malformed
    // multi-dot thousands input instead of silently truncating it.
    const parsedAmount = parseUsdAmount(amount);
    const resolvedReason = resolveReason();
    if (!parsedAmount.ok) {
      toast.error(parsedAmount.error);
      return;
    }
    const numAmount = parsedAmount.value;
    if (numAmount <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    // Note: we deliberately allow numAmount > availableBalance — the
    // server will deduct what exists and bump total_withdrawn by the
    // full amount (backfill mode for fixing P&L on past off-platform
    // payouts).
    if (!resolvedReason) {
      toast.error(
        reasonCategory === "other"
          ? "Please enter a custom reason"
          : "Please pick a reason",
      );
      return;
    }
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        const result = await recordManualWithdrawal({
          userId,
          amountUsd: numAmount,
          reason: resolvedReason,
          totpCode: totpCode.trim(),
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success(`Recorded $${numAmount.toFixed(2)} manual withdrawal`);
        setAmount("");
        setReasonCategory("");
        setCustomReason("");
        setTotpCode("");
        onOpenChange(false);
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to record manual withdrawal",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowDownToLine className="size-4 text-rose-500" />
            Record Manual Withdrawal
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-xs text-muted-foreground">
            Use this when you paid the user out off-platform (bank, crypto,
            etc.). Bumps <span className="font-mono">total_withdrawn</span>{" "}
            so P&amp;L stays correct. If they have on-site balance, it&apos;s
            deducted from there too. Works for backfilling historical
            payouts even when the user has $0 on-site.
          </p>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Amount (USD)
            </Label>
            {/* text + inputMode="decimal" so commas / multi-dot input
                reach the robust parser intact (a number input drops them). */}
            <Input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00 (e.g. 17878.54)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {(() => {
              const parsed = parseUsdAmount(amount);
              if (amount.trim().length > 0 && !parsed.ok) {
                return (
                  <p className="text-[11px] text-rose-600 dark:text-rose-400">
                    {parsed.error}
                  </p>
                );
              }
              const numAmount = parsed.ok ? parsed.value : NaN;
              const exceeds =
                !isNaN(numAmount) && numAmount > availableBalance;
              if (exceeds) {
                const phantom = numAmount - availableBalance;
                return (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    On-site balance is ${availableBalance.toFixed(2)}. $
                    {availableBalance.toFixed(2)} will be deducted from
                    balance; the remaining ${phantom.toFixed(2)} only
                    bumps total_withdrawn (backfill / P&amp;L fix).
                  </p>
                );
              }
              if (parsed.ok && numAmount > 0) {
                return (
                  <p className="text-[11px] text-muted-foreground">
                    Recording{" "}
                    <span className="font-semibold text-foreground tabular-nums">
                      {formatCurrency(numAmount)}
                    </span>{" "}
                    · Available: ${availableBalance.toFixed(2)}
                  </p>
                );
              }
              return (
                <p className="text-[11px] text-muted-foreground">
                  Available: ${availableBalance.toFixed(2)}
                </p>
              );
            })()}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Payout method
            </Label>
            <Select
              value={reasonCategory}
              onValueChange={(v) => {
                if (!v) return;
                setReasonCategory(v);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="How did you pay them out?" />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_WITHDRAWAL_REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {reasonCategory === "other" && (
              <Textarea
                placeholder="Describe the payout method"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                rows={2}
                className="mt-2"
              />
            )}
          </div>
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
        </div>
        <DialogFooter>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={isPending || !totpCode.trim()}
            className="w-full sm:w-auto bg-rose-500 hover:bg-rose-500/90 text-white"
          >
            {isPending ? "Recording..." : "Record Withdrawal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function XpAdjustDialog({
  userId,
  open,
  onOpenChange,
}: {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  // 2FA gate — security parity with BalanceAdjustDialog. The server
  // action `adjustXp` calls `require2FA(session.userId, totpCode)`
  // before mutating user_statistics.xp, so we collect + send the
  // 6-digit TOTP code here. Reset on dialog close.
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleAdjust() {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || !reason.trim()) {
      toast.error("Please enter a valid amount and reason");
      return;
    }
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        await adjustXp({ userId, amount: numAmount, reason, totpCode: totpCode.trim() });
        toast.success("XP adjusted");
        setAmount("");
        setReason("");
        setTotpCode("");
        onOpenChange(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to adjust XP");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust XP</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Amount</Label>
            <Input
              type="number"
              placeholder="Amount (+/-)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Reason</Label>
            <Textarea
              placeholder="Reason..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>
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
        </div>
        <DialogFooter>
          <Button
            size="sm"
            onClick={handleAdjust}
            disabled={isPending || !totpCode.trim()}
            className="w-full sm:w-auto"
          >
            {isPending ? "Adjusting..." : "Apply Adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Change Role Dialog (Admin Only) — Select new role + confirm with 2FA
// ---------------------------------------------------------------------------
export function ChangeRoleDialog({
  userId,
  currentRole,
}: {
  userId: string;
  currentRole: string;
}) {
  const [open, setOpen] = useState(false);
  const [newRole, setNewRole] = useState<string>(currentRole);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleOpenChange(v: boolean) {
    setOpen(v);
    if (!v) {
      // Reset form on close
      setNewRole(currentRole);
      setTotpCode("");
    }
  }

  function handleSubmit() {
    if (!newRole || newRole === currentRole) {
      toast.error("Please pick a different role");
      return;
    }
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        await changeRole(userId, newRole, totpCode.trim());
        toast.success("Role updated");
        setOpen(false);
        setTotpCode("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update role");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button variant="outline" size="sm" className="h-8 gap-1.5" />}
      >
        <ShieldCheck className="size-3.5" />
        Change Role
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change Site Role</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {/* Disambiguates from admin-panel roles — this control only
              governs the user's role on the game platform. */}
          <p className="rounded-md bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
            Sets the user&apos;s role on the game platform (packy.gg). This
            does <span className="font-medium text-foreground">not</span> grant
            access to this admin panel — admin-panel access is managed
            separately under Admin Users.
          </p>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Site role</Label>
            <Select
              value={newRole}
              onValueChange={(v) => {
                if (!v) return;
                setNewRole(v);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a role..." />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Current role:{" "}
              <span className="font-medium text-foreground">{currentRole}</span>
            </p>
          </div>
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
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={
              isPending || !totpCode.trim() || newRole === currentRole
            }
            className="w-full sm:w-auto"
          >
            {isPending ? "Updating..." : "Change role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Reset Role to User — escape hatch when the /creators backend demote
// gets stuck (returns success but doesn't actually flip role back).
// Calls `forceResetCreatorToUser` which:
//   1) tries `creatorsApi.demote()` first so the backend can roll back
//      promote-time side effects (creator-deal balance fills, cached
//      aggregations, session state) — this is the part that was
//      missing before; without it, the user's pre-creator P&L numbers
//      never come back to the dashboard
//   2) always writes `user.role = 'user'` directly so the role flip
//      is guaranteed even if the backend silently no-ops
// Only renders when the user's current role is "creator".
// ---------------------------------------------------------------------------
export function ResetRoleToUserButton({
  userId,
  currentRole,
}: {
  userId: string;
  currentRole: string;
}) {
  const [open, setOpen] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  if (currentRole !== "creator") return null;

  function handleOpenChange(v: boolean) {
    setOpen(v);
    if (!v) setTotpCode("");
  }

  function handleSubmit() {
    if (!totpCode.trim()) {
      toast.error("Enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        // Combined action: backend demote (best-effort) + local role
        // flip (always). Tells us in the toast whether the backend
        // cleanup ran or was skipped — if skipped, the dashboard P&L
        // may still be off because backend-managed side effects (e.g.
        // creator balance fills) were never reverted.
        const result = await forceResetCreatorToUser(
          userId,
          totpCode.trim(),
        );
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        if (result.backendDemoted) {
          toast.success(
            "Role reset to user — backend cleaned up + role flipped",
          );
        } else {
          toast.warning(
            `Role flipped locally, but backend demote failed${
              result.backendError ? `: ${result.backendError}` : ""
            }. P&L side effects may still need manual fix.`,
            { duration: 8000 },
          );
        }
        setOpen(false);
        setTotpCode("");
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to reset role",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
            title="Force role back to 'user' (calls backend demote + direct DB write)"
          />
        }
      >
        <ShieldAlert className="size-3.5" />
        Reset to User
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset Role to User</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            Force-demotes this user from{" "}
            <span className="font-mono font-medium text-foreground">
              creator
            </span>{" "}
            back to{" "}
            <span className="font-mono font-medium text-foreground">user</span>.
          </p>
          <p className="text-xs text-muted-foreground">
            Runs <strong>backend demote</strong> first so promote-time
            side effects (creator-deal balance fills, cached
            aggregations, session state) are rolled back, then writes
            the role flip directly so it&apos;s guaranteed even if the
            backend silently no-ops. Use when the &quot;Revoke creator
            role&quot; button on /creators is unresponsive or the
            user&apos;s pre-creator numbers haven&apos;t come back to
            P&amp;L.
          </p>
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
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={isPending || !totpCode.trim()}
            className="w-full sm:w-auto bg-amber-500 text-white hover:bg-amber-500/90"
          >
            {isPending ? "Resetting..." : "Reset Role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
