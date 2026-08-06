"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { CreatorRewardProgramWithStats } from "@/lib/creator-vip/types";

import { HubNotice } from "../../_components/hub-notice";
import {
  createCreatorRewardProgram,
  searchCreatorsWithCodes,
  updateCreatorRewardProgram,
  type CreatorSearchResult,
} from "../actions";
import { CreatorPicker } from "./creator-picker";

/** Empty string for a null money field, so the inputs stay controlled. */
function moneyField(v: number | null): string {
  return v == null ? "" : String(v);
}

/**
 * Create OR edit a reward program — one form, because the terms, their
 * validation mirror and the money-pump guard are identical in both. The only
 * real difference is the two fields an edit MUST NOT touch: the creator and the
 * accrual start (see `updateCreatorRewardProgram` for why re-pointing either
 * would rewrite history rather than change a setting).
 */
export function ProgramFormDialog({
  open,
  onOpenChange,
  program,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Present = edit that program. Absent = create a new one. */
  program?: CreatorRewardProgramWithStats;
}) {
  const isEdit = program != null;
  const uid = useId();

  const [name, setName] = useState(program?.name ?? "");
  const [selected, setSelected] = useState<CreatorSearchResult | null>(null);
  /**
   * Every code the creator owns — the pick list. In create mode it arrives with
   * the picked creator; in edit mode there is no picker, so it is looked up by
   * user id (the search action matches an exact id) and falls back to the
   * program's own codes if that creator is no longer listed.
   */
  const [creatorCodes, setCreatorCodes] = useState<string[]>(
    program?.codes ?? [],
  );
  const [pickedCodes, setPickedCodes] = useState<string[]>(program?.codes ?? []);
  // Both legs can run at once — creators hand them out together.
  const [wagerOn, setWagerOn] = useState(
    isEdit ? program.thresholdUsd != null && program.rewardUsd != null : true,
  );
  const [lossbackOn, setLossbackOn] = useState(
    isEdit ? program.lossbackPct != null && program.minDepositUsd != null : true,
  );
  const [threshold, setThreshold] = useState(
    isEdit ? moneyField(program.thresholdUsd) : "1000",
  );
  const [reward, setReward] = useState(
    isEdit ? moneyField(program.rewardUsd) : "5",
  );
  const [vipReward, setVipReward] = useState(
    isEdit ? moneyField(program.vipRewardUsd) : "",
  );
  const [lossbackPct, setLossbackPct] = useState(
    isEdit ? moneyField(program.lossbackPct) : "5",
  );
  const [minDeposit, setMinDeposit] = useState(
    isEdit ? moneyField(program.minDepositUsd) : "50",
  );
  const [cap, setCap] = useState(
    isEdit ? moneyField(program.maxRewardPerUserUsd) : "",
  );
  const [isPending, startTransition] = useTransition();

  const thresholdNum = Number(threshold);
  const rewardNum = Number(reward);
  const vipRewardNum = vipReward.trim() === "" ? null : Number(vipReward);
  const lossbackPctNum = Number(lossbackPct);
  const minDepositNum = Number(minDeposit);

  // Mirrors validateTerms() on the server. The server stays authoritative;
  // this only stops the operator submitting what it would refuse.
  const wagerInvalid =
    wagerOn &&
    ((Number.isFinite(thresholdNum) &&
      Number.isFinite(rewardNum) &&
      rewardNum >= thresholdNum) ||
      (vipRewardNum != null &&
        (!Number.isFinite(vipRewardNum) ||
          vipRewardNum >= thresholdNum ||
          vipRewardNum < rewardNum)));
  const lossbackInvalid =
    lossbackOn &&
    (!Number.isFinite(lossbackPctNum) ||
      lossbackPctNum <= 0 ||
      lossbackPctNum >= 100 ||
      !Number.isFinite(minDepositNum) ||
      minDepositNum <= 0);
  const nothingOn = !wagerOn && !lossbackOn;
  const ratesInvalid = wagerInvalid || lossbackInvalid || nothingOn;

  function reset() {
    setName(program?.name ?? "");
    setSelected(null);
    setCreatorCodes(program?.codes ?? []);
    setPickedCodes(program?.codes ?? []);
    setWagerOn(
      isEdit ? program.thresholdUsd != null && program.rewardUsd != null : true,
    );
    setLossbackOn(
      isEdit
        ? program.lossbackPct != null && program.minDepositUsd != null
        : true,
    );
    setThreshold(isEdit ? moneyField(program.thresholdUsd) : "1000");
    setReward(isEdit ? moneyField(program.rewardUsd) : "5");
    setVipReward(isEdit ? moneyField(program.vipRewardUsd) : "");
    setLossbackPct(isEdit ? moneyField(program.lossbackPct) : "5");
    setMinDeposit(isEdit ? moneyField(program.minDepositUsd) : "50");
    setCap(isEdit ? moneyField(program.maxRewardPerUserUsd) : "");
  }

  // Edit mode has no picker, so the creator's FULL code list has to come from
  // somewhere — otherwise the operator can only ever remove codes, never add
  // one the program didn't already carry.
  useEffect(() => {
    if (!open || !isEdit) return;
    let cancelled = false;
    void searchCreatorsWithCodes(program.creatorUserId)
      .then((rows) => {
        if (cancelled) return;
        const match = rows.find((r) => r.userId === program.creatorUserId);
        if (match && match.codes.length > 0) setCreatorCodes(match.codes);
      })
      .catch(() => {
        // Keep the program's own codes — the form still saves, it just can't
        // offer codes it never knew about.
      });
    return () => {
      cancelled = true;
    };
  }, [open, isEdit, program?.creatorUserId]);

  const codeChoices = isEdit
    ? [...new Set([...creatorCodes, ...program.codes])]
    : (selected?.codes ?? []);

  function submit() {
    const creator = selected;
    if (!isEdit && !creator) {
      toast.error("Pick a creator");
      return;
    }
    if (pickedCodes.length === 0) {
      toast.error("Pick at least one code");
      return;
    }
    const terms = {
      name: name.trim(),
      codes: pickedCodes,
      thresholdUsd: wagerOn ? thresholdNum : null,
      rewardUsd: wagerOn ? rewardNum : null,
      vipRewardUsd: wagerOn ? vipRewardNum : null,
      lossbackPct: lossbackOn ? lossbackPctNum : null,
      minDepositUsd: lossbackOn ? minDepositNum : null,
      maxRewardPerUserUsd: cap.trim() === "" ? null : Number(cap),
    };
    startTransition(async () => {
      const res = program
        ? await updateCreatorRewardProgram({ programId: program.id, ...terms })
        : await createCreatorRewardProgram({
            creatorUserId: creator?.userId ?? "",
            ...terms,
          });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(isEdit ? "Program updated" : "Program created");
      if (!isEdit) reset();
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit program" : "New VIP wager program"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Terms only — the creator and the accrual start are fixed for the life of a program."
              : "Accrual starts now — wager booked before this moment never counts."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isEdit && (
            <HubNotice tone="blue">
              New terms apply to the NEXT offer only. Claims already raised keep
              the amount the player was quoted, and turning a leg off does not
              withdraw the pending claims it already produced. Renaming changes
              the name shown in the Discord decision DM for every claim not yet
              decided.
            </HubNotice>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs" id={`${uid}-legs`}>
              Rewards this program gives
            </Label>
            <div
              className="space-y-2 rounded-md border p-3"
              role="group"
              aria-labelledby={`${uid}-legs`}
            >
              <label className="flex items-start gap-2.5">
                <Switch
                  checked={wagerOn}
                  onCheckedChange={setWagerOn}
                  disabled={isPending}
                />
                <span className="text-sm">
                  Wager milestones
                  <span className="block text-[11px] text-muted-foreground">
                    Recurring — pays every time they wager another full
                    threshold under the code.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5">
                <Switch
                  checked={lossbackOn}
                  onCheckedChange={setLossbackOn}
                  disabled={isPending}
                />
                <span className="text-sm">
                  First-deposit lossback
                  <span className="block text-[11px] text-muted-foreground">
                    Once, ever — a % of what they lost from their FIRST deposit.
                    Needs signup under the code; a second deposit closes it.
                  </span>
                </span>
              </label>
            </div>
            {nothingOn && (
              <p className="text-[11px] text-rose-600 dark:text-rose-400">
                Turn on at least one.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor={`${uid}-name`}>
              Program name
            </Label>
            <Input
              id={`${uid}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jimmy VIP wager reward"
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor={`${uid}-creator`}>
              Creator
            </Label>
            {isEdit ? (
              <div
                id={`${uid}-creator`}
                className="rounded-md border px-3 py-2 text-sm"
              >
                {program.creatorUsername ?? program.creatorUserId}
                <span className="block text-[11px] text-muted-foreground">
                  Fixed — a program is an accrual instrument for one creator.
                </span>
              </div>
            ) : selected ? (
              <div
                id={`${uid}-creator`}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <span className="text-sm">
                  {selected.username ?? selected.userId}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSelected(null);
                    setPickedCodes([]);
                  }}
                  disabled={isPending}
                >
                  Change
                </Button>
              </div>
            ) : (
              <CreatorPicker
                inputId={`${uid}-creator`}
                active={open}
                disabled={isPending}
                onSelect={(r) => {
                  setSelected(r);
                  setPickedCodes(r.codes);
                }}
              />
            )}
          </div>

          {(isEdit || selected) && (
            <div className="space-y-1.5">
              <Label className="text-xs" id={`${uid}-codes`}>
                Codes this program accrues on
              </Label>
              {codeChoices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This creator owns no affiliate codes — nothing to attach.
                </p>
              ) : (
                <div
                  className="flex flex-wrap gap-1.5"
                  role="group"
                  aria-labelledby={`${uid}-codes`}
                >
                  {codeChoices.map((c) => {
                    const on = pickedCodes.includes(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        disabled={isPending}
                        aria-pressed={on}
                        onClick={() =>
                          setPickedCodes((prev) =>
                            on ? prev.filter((x) => x !== c) : [...prev, c],
                          )
                        }
                        className={cn(
                          "rounded-md border px-2 py-1 font-mono text-xs transition-colors",
                          on
                            ? "border-primary/40 bg-primary/10 text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {lossbackOn && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor={`${uid}-lossback`}>
                  Lossback (%)
                </Label>
                <Input
                  id={`${uid}-lossback`}
                  type="number"
                  min="0.01"
                  max="99.99"
                  step="0.01"
                  value={lossbackPct}
                  onChange={(e) => setLossbackPct(e.target.value)}
                  disabled={isPending}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor={`${uid}-min-deposit`}>
                  Minimum first deposit ($)
                </Label>
                <Input
                  id={`${uid}-min-deposit`}
                  type="number"
                  min="1"
                  value={minDeposit}
                  onChange={(e) => setMinDeposit(e.target.value)}
                  disabled={isPending}
                />
              </div>
            </div>
          )}

          {wagerOn && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor={`${uid}-threshold`}>
                  Wager threshold ($)
                </Label>
                <Input
                  id={`${uid}-threshold`}
                  type="number"
                  min="1"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  disabled={isPending}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor={`${uid}-reward`}>
                  Reward ($)
                </Label>
                <Input
                  id={`${uid}-reward`}
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={reward}
                  onChange={(e) => setReward(e.target.value)}
                  disabled={isPending}
                />
              </div>
            </div>
          )}

          {wagerOn && (
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor={`${uid}-vip-reward`}>
                VIP reward ($) — optional
              </Label>
              <Input
                id={`${uid}-vip-reward`}
                type="number"
                min="0.01"
                step="0.01"
                value={vipReward}
                onChange={(e) => setVipReward(e.target.value)}
                placeholder="Same as standard"
                disabled={isPending}
              />
              <p className="text-[11px] text-muted-foreground">
                Paid instead of the standard rate to players carrying the VIP
                tag. Checked live on every claim — losing the tag drops them back
                to the standard rate immediately.
              </p>
            </div>
          )}

          {ratesInvalid && (
            <p className="text-sm text-rose-600 dark:text-rose-400">
              {nothingOn
                ? "Turn on at least one reward."
                : lossbackInvalid
                  ? "Lossback must be between 0 and 100%, with a positive minimum deposit."
                  : "Rewards must be under the threshold, and the VIP rate at least the standard one."}
            </p>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor={`${uid}-cap`}>
              Lifetime cap per user ($) — optional
            </Label>
            <Input
              id={`${uid}-cap`}
              type="number"
              min="0"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="No cap"
              disabled={isPending}
            />
          </div>

          {wagerOn &&
            Number.isFinite(thresholdNum) &&
            Number.isFinite(rewardNum) &&
            !ratesInvalid &&
            thresholdNum > 0 && (
              <HubNotice tone="muted">
                Effective rate:{" "}
                <strong className="text-foreground">
                  {((rewardNum / thresholdNum) * 100).toFixed(2)}%
                </strong>{" "}
                of wagered volume.
              </HubNotice>
            )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={isPending || ratesInvalid || (!isEdit && !selected)}
          >
            {isPending
              ? isEdit
                ? "Saving…"
                : "Creating…"
              : isEdit
                ? "Save changes"
                : "Create program"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
