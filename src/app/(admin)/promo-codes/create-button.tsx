"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
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
import { createPromoCode } from "./actions";

export function CreatePromoCodeButton() {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [code, setCode] = useState("");
  const [value, setValue] = useState("");
  const [region, setRegion] = useState<"NA" | "EU">("NA");
  const [minimumLevel, setMinimumLevel] = useState("0");
  const [minimumWagerAmount, setMinimumWagerAmount] = useState("0");
  const [wagerPeriodDays, setWagerPeriodDays] = useState("0");
  const [minimumAccountAgeDays, setMinimumAccountAgeDays] = useState("0");
  const [maximumAccountAgeHours, setMaximumAccountAgeHours] = useState("0");
  const [minimumDepositAmount, setMinimumDepositAmount] = useState("0");
  const [requiredAffiliateCode, setRequiredAffiliateCode] = useState("");
  const [requiresDiscord, setRequiresDiscord] = useState(true);
  const [maxUses, setMaxUses] = useState("1");
  const [expiresAt, setExpiresAt] = useState("");

  function reset() {
    setCode("");
    setValue("");
    setRegion("NA");
    setMinimumLevel("0");
    setMinimumWagerAmount("0");
    setWagerPeriodDays("0");
    setMinimumAccountAgeDays("0");
    setMaximumAccountAgeHours("0");
    setMinimumDepositAmount("0");
    setRequiredAffiliateCode("");
    setRequiresDiscord(true);
    setMaxUses("1");
    setExpiresAt("");
  }

  function handleSubmit() {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue <= 0) {
      toast.error("Please enter a valid value");
      return;
    }
    if (!code.trim()) {
      toast.error("Please enter a code");
      return;
    }

    startTransition(async () => {
      try {
        await createPromoCode({
          code: code.trim(),
          value: numValue,
          region,
          minimumLevel: parseInt(minimumLevel) || 0,
          minimumWagerAmount: parseFloat(minimumWagerAmount) || 0,
          wagerPeriodDays: parseInt(wagerPeriodDays) || 0,
          minimumAccountAgeDays: parseInt(minimumAccountAgeDays) || 0,
          maximumAccountAgeHours: parseInt(maximumAccountAgeHours) || 0,
          minimumDepositAmount: parseFloat(minimumDepositAmount) || 0,
          requiredAffiliateCode: requiredAffiliateCode,
          requiresDiscord,
          maxUses: parseInt(maxUses) || 1,
          expiresAt: expiresAt || null,
        });
        toast.success("Promo code created");
        setOpen(false);
        reset();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to create promo code");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>Create Promo Code</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Promo Code</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* Code + Value */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Code</Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="SUMMER2024"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Value (USD)</Label>
              <Input
                type="number"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="5.00"
              />
            </div>
          </div>

          {/* Region + Max Uses */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Region</Label>
              <Select value={region} onValueChange={(v) => setRegion(v as "NA" | "EU")}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NA">NA</SelectItem>
                  <SelectItem value="EU">EU</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max Uses</Label>
              <Input
                type="number"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
              />
            </div>
          </div>

          {/* Requirements header */}
          <div className="border-t pt-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Requirements
            </p>

            {/* Discord + Min Level */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Discord Linked</Label>
                <Select
                  value={requiresDiscord ? "yes" : "no"}
                  onValueChange={(v) => setRequiresDiscord(v === "yes")}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">Required</SelectItem>
                    <SelectItem value="no">Not required</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Min Level</Label>
                <Input
                  type="number"
                  value={minimumLevel}
                  onChange={(e) => setMinimumLevel(e.target.value)}
                />
              </div>
            </div>

            {/* Min Wager + Wager Period */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 mt-3">
              <div className="space-y-1">
                <Label className="text-xs">Min Wager (USD)</Label>
                <Input
                  type="number"
                  value={minimumWagerAmount}
                  onChange={(e) => setMinimumWagerAmount(e.target.value)}
                  placeholder="0 = no minimum"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Wager Period (days)</Label>
                <Input
                  type="number"
                  value={wagerPeriodDays}
                  onChange={(e) => setWagerPeriodDays(e.target.value)}
                  placeholder="0 = lifetime"
                />
                <p className="text-[10px] text-muted-foreground">
                  0 = lifetime, 30 = last 30 days
                </p>
              </div>
            </div>

            {/* Min Account Age + Max Account Age */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 mt-3">
              <div className="space-y-1">
                <Label className="text-xs">Min Account Age (days)</Label>
                <Input
                  type="number"
                  value={minimumAccountAgeDays}
                  onChange={(e) => setMinimumAccountAgeDays(e.target.value)}
                  placeholder="0 = no minimum"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Max Account Age (hours)</Label>
                <Input
                  type="number"
                  value={maximumAccountAgeHours}
                  onChange={(e) => setMaximumAccountAgeHours(e.target.value)}
                  placeholder="0 = no maximum"
                />
                <p className="text-[10px] text-muted-foreground">
                  New-signup gate. 24 = first 24h after signup only.
                </p>
              </div>
            </div>

            {/* Min Deposit */}
            <div className="grid grid-cols-1 gap-4 mt-3">
              <div className="space-y-1">
                <Label className="text-xs">Min Deposit (USD, all-time)</Label>
                <Input
                  type="number"
                  value={minimumDepositAmount}
                  onChange={(e) => setMinimumDepositAmount(e.target.value)}
                  placeholder="0 = no minimum"
                />
              </div>
            </div>

            {/* Required Affiliate Code */}
            <div className="grid grid-cols-1 gap-4 mt-3">
              <div className="space-y-1">
                <Label className="text-xs">Required Affiliate Code</Label>
                <Input
                  value={requiredAffiliateCode}
                  onChange={(e) => setRequiredAffiliateCode(e.target.value)}
                  placeholder="ALICE  or  ALICE,BOB,CHARLIE"
                />
                <p className="text-[10px] text-muted-foreground">
                  User&apos;s currently carried referral code must match one
                  of these (case-insensitive). Comma-separate to allow
                  multiple codes.
                </p>
              </div>
            </div>
          </div>

          {/* Expires */}
          <div className="space-y-1">
            <Label className="text-xs">Expires At (optional)</Label>
            <Input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={isPending} className="w-full sm:w-auto">
            {isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
