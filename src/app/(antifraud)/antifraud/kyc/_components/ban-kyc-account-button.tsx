"use client";

import { useRef, useState, useTransition } from "react";
import { Ban, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { StepUpField } from "@/components/step-up-field";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ANTIFRAUD_BAN_REASON_PRESETS } from "@/lib/ban-reasons";
import { banAccountFromKyc } from "../actions";

export function BanKycAccountButton({
  userId,
  label,
  verificationCycle,
}: {
  userId: string;
  label: string;
  verificationCycle: number;
}) {
  const router = useRouter();
  const [reasonOption, setReasonOption] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [credential, setCredential] = useState("");
  const [pending, startTransition] = useTransition();
  const idempotencyKey = useRef<string | null>(null);
  const reason = reasonOption === "custom" ? customReason.trim() : reasonOption;

  function submit() {
    startTransition(async () => {
      idempotencyKey.current ??= crypto.randomUUID();
      const result = await banAccountFromKyc({
        userId,
        reason,
        expectedCycle: verificationCycle,
        credential,
        idempotencyKey: idempotencyKey.current,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Account banned and moved to KYC history.");
      setCredential("");
      router.refresh();
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button size="xs" variant="destructive" disabled={pending} />}
      >
        <Ban className="mr-1.5 size-3.5" />
        Ban
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Ban {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            This bans the account, revokes its sessions, blocks its known IPs
            and fingerprints, and moves KYC cycle {verificationCycle} from the
            active list into History. The KYC evidence is preserved.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Ban reason</Label>
            <Select
              value={reasonOption || undefined}
              onValueChange={(value) => setReasonOption(value ?? "")}
              disabled={pending}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a reason" />
              </SelectTrigger>
              <SelectContent>
                {ANTIFRAUD_BAN_REASON_PRESETS.map((item) => (
                  <SelectItem key={item} value={item}>{item}</SelectItem>
                ))}
                <SelectItem value="custom">Custom reason</SelectItem>
              </SelectContent>
            </Select>
            {reasonOption === "custom" && (
              <Input
                value={customReason}
                onChange={(event) => setCustomReason(event.target.value)}
                minLength={4}
                maxLength={500}
                placeholder="Write the exact reason"
                disabled={pending}
              />
            )}
          </div>
          <StepUpField
            value={credential}
            onChange={setCredential}
            disabled={pending}
            label="Fresh TOTP or passkey"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={submit}
            disabled={pending || !credential || reason.length < 4}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Ban />}
            {pending ? "Banning…" : "Ban and remove from active KYC"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
