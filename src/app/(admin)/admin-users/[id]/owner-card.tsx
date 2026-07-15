"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Crown, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { StepUpField } from "@/components/step-up-field";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { setAdminOwner } from "./owner-actions";

/**
 * Owner / ultra-admin management card on the admin-user detail page.
 *
 * Rendered ONLY for the main owner (motha) — the parent gates visibility. For
 * motha's OWN row it shows a read-only "Main owner (permanent)" state (motha
 * can't be un-ownered). For any other admin it shows a Switch that opens a 2FA
 * confirm dialog before flipping `admin_users.is_owner` via `setAdminOwner`.
 *
 * House modern style: clean Card + amber accent (privileged action), dark-mode
 * aware, responsive.
 */
export function OwnerCard({
  adminUserId,
  username,
  isOwner,
  isMainOwner,
}: {
  adminUserId: string;
  username: string;
  /** Current effective owner state (drives the switch position / badge). */
  isOwner: boolean;
  /** True if this row is the permanent root owner (motha) → read-only. */
  isMainOwner: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingValue, setPendingValue] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  function requestToggle(next: boolean) {
    setPendingValue(next);
    setTotpCode("");
    setDialogOpen(true);
  }

  function confirm() {
    startTransition(async () => {
      try {
        await setAdminOwner(adminUserId, pendingValue, totpCode.trim());
        toast.success(pendingValue ? "Owner granted" : "Owner revoked");
        setDialogOpen(false);
        setTotpCode("");
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to update owner status",
        );
      }
    });
  }

  return (
    <Card className="border-amber-500/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Crown className="size-4 text-amber-500" />
          Owner / ultra-admin
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Owners see everything, with no restrictions — they bypass every page
          and capability check as well as the owner-only surfaces (Salaries,
          Excluded Users, the re-price tool, Insights, and more).
        </p>

        {isMainOwner ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Main owner (permanent)</p>
              <p className="text-xs text-muted-foreground">
                The root owner can never be removed or demoted.
              </p>
            </div>
            <Badge
              variant="outline"
              className="shrink-0 border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400"
            >
              <Crown className="mr-1 size-3" />
              Owner
            </Badge>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {isOwner ? "Owner" : "Not an owner"}
              </p>
              <p className="text-xs text-muted-foreground">
                {isOwner
                  ? `${username} has full ultra-admin access.`
                  : `Grant ${username} full ultra-admin access.`}
              </p>
            </div>
            <Switch
              checked={isOwner}
              onCheckedChange={(next) => requestToggle(next)}
              disabled={isPending}
              aria-label={isOwner ? "Revoke owner status" : "Grant owner status"}
            />
          </div>
        )}
      </CardContent>

      <AlertDialog
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v);
          if (!v) setTotpCode("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-amber-500" />
              {pendingValue ? "Grant owner status?" : "Revoke owner status?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingValue
                ? `${username} will gain FULL ultra-admin access — every page, every capability, and every owner-only surface. Enter your 2FA code to confirm.`
                : `${username} will lose ultra-admin access. Enter your 2FA code to confirm.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <StepUpField value={totpCode} onChange={setTotpCode} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button
              disabled={!totpCode.trim() || isPending}
              onClick={confirm}
            >
              {pendingValue ? "Grant owner" : "Revoke owner"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
