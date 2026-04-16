"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";
import { setMaintenanceMode } from "./actions";

const DEFAULT_MESSAGE =
  "We're currently performing scheduled maintenance. Packy.gg will be back shortly — thanks for your patience!";

export function MaintenanceModeCard({
  initialEnabled,
  initialMessage,
}: {
  initialEnabled: boolean;
  initialMessage: string;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [message, setMessage] = useState(initialMessage);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const messageChanged = message.trim() !== initialMessage.trim();

  function save(nextEnabled: boolean, nextMessage: string) {
    startTransition(async () => {
      try {
        const result = await setMaintenanceMode(nextEnabled, nextMessage);
        if (!result.success) {
          toast.error(result.error);
          // Revert optimistic UI state
          setEnabled(initialEnabled);
          return;
        }
        toast.success(
          nextEnabled
            ? "Maintenance mode ENABLED on packy.gg"
            : "Maintenance mode disabled — packy.gg is live again",
        );
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to update maintenance mode",
        );
        setEnabled(initialEnabled);
      }
    });
  }

  function handleToggle(next: boolean) {
    if (next) {
      // Enabling — show a big confirmation
      setConfirmOpen(true);
    } else {
      setEnabled(false);
      save(false, message || DEFAULT_MESSAGE);
    }
  }

  function handleConfirmEnable() {
    setConfirmOpen(false);
    setEnabled(true);
    save(true, message || DEFAULT_MESSAGE);
  }

  function handleSaveMessage() {
    save(enabled, message);
  }

  return (
    <Card
      className={cn(
        "border-2 transition-colors",
        enabled
          ? "border-amber-500/60 bg-amber-500/[0.04]"
          : "border-border",
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle
              className={cn(
                "size-5",
                enabled ? "text-amber-500" : "text-muted-foreground",
              )}
            />
            <CardTitle className="text-base font-semibold">
              Maintenance Mode
            </CardTitle>
            <Badge
              variant="outline"
              className={
                enabled
                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
                  : "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
              }
            >
              {enabled ? "ON" : "OFF"}
            </Badge>
          </div>
          <Switch
            checked={enabled}
            disabled={isPending}
            onCheckedChange={handleToggle}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          When enabled, <span className="font-mono text-foreground">packy.gg</span> blocks
          non-admin users and shows the maintenance screen with the message
          below. Toggling this writes to{" "}
          <code className="rounded bg-muted px-1 text-[11px]">site_config.maintenance_mode</code>{" "}
          and pings the backend to refresh its cache immediately.
        </p>

        <div className="space-y-2">
          <Label className="text-sm">Message shown to users</Label>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={DEFAULT_MESSAGE}
            rows={3}
            maxLength={500}
            disabled={isPending}
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {message.length}/500 characters. Leave empty to use the default.
            </p>
            {messageChanged && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleSaveMessage}
                disabled={isPending}
              >
                {isPending ? "Saving..." : "Save message"}
              </Button>
            )}
          </div>
        </div>
      </CardContent>

      {/* Big scary confirmation when enabling */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogTrigger className="hidden" />
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-500" />
              Enable maintenance mode on packy.gg?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will <strong>immediately block non-admin users</strong> from
              accessing packy.gg. Active sessions will see the maintenance
              screen on their next request. Admins can still use the game
              site. Disable again by flipping the switch off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmEnable}
              className="bg-amber-600 text-white hover:bg-amber-700"
            >
              Enable Maintenance Mode
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
