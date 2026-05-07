"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ADMIN_PAGES } from "@/lib/admin-pages";
import { updateUserPermissions } from "./actions";
import type { AdminUserDetail } from "@/lib/queries/admin-users";

/* ── Permissions Section ──
 *
 * Permission edits used to auto-save on every toggle. That worked when
 * the action was a free pass, but `updateUserPermissions` now requires
 * TOTP — prompting on every flip would be unusable. The UI now stages
 * pending changes locally and only persists them when the operator
 * confirms with their 2FA code in a single Save dialog.
 */
export function PermissionsSection({ detail }: { detail: AdminUserDetail }) {
  // The "saved" baseline (mirrors the server). `pages` is the staged
  // working copy that the toggles mutate. `dirty` derives from the diff.
  const [savedPages, setSavedPages] = useState<string[]>(detail.allowedPages);
  const [pages, setPages] = useState<string[]>(detail.allowedPages);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const groups = ADMIN_PAGES.reduce<Record<string, typeof ADMIN_PAGES>>((acc, page) => {
    (acc[page.group] ??= []).push(page);
    return acc;
  }, {});

  // Equality check by content — array order isn't meaningful for the
  // server (it dedupes/filters), so we compare set membership.
  const isDirty =
    pages.length !== savedPages.length ||
    pages.some((p) => !savedPages.includes(p));

  function toggle(key: string) {
    const next = pages.includes(key) ? pages.filter((p) => p !== key) : [...pages, key];
    setPages(next);
  }

  function toggleGroup(group: string) {
    const groupKeys = groups[group].map((p) => p.key);
    const allChecked = groupKeys.every((k) => pages.includes(k));
    const next = allChecked
      ? pages.filter((p) => !groupKeys.includes(p))
      : Array.from(new Set([...pages, ...groupKeys]));
    setPages(next);
  }

  function discard() {
    setPages(savedPages);
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
        await updateUserPermissions(detail.id, pages, totpCode.trim());
        toast.success("Permissions updated");
        // Pin the new baseline so the dirty flag clears.
        setSavedPages(pages);
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
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Permissions</CardTitle>
        {isDirty && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={discard}
              disabled={isPending}
            >
              Discard
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={isPending}
            >
              Save changes
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 text-left text-sm font-medium">Page</th>
                <th className="px-4 py-2 text-center text-sm font-medium w-24">Access</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(groups).map(([group, groupPages]) => {
                const groupKeys = groupPages.map((p) => p.key);
                const allChecked = groupKeys.every((k) => pages.includes(k));
                return (
                  <Fragment key={group}>
                    <tr className="border-b bg-muted/30">
                      <td className="px-4 py-2 text-sm font-semibold">{group}</td>
                      <td className="px-4 py-2 text-center">
                        <Switch
                          size="sm"
                          checked={allChecked}
                          disabled={isPending}
                          onCheckedChange={() => toggleGroup(group)}
                        />
                      </td>
                    </tr>
                    {groupPages.map((page) => (
                      <tr key={page.key} className="border-b">
                        <td className="px-4 py-2 pl-8 text-sm text-muted-foreground">{page.label}</td>
                        <td className="px-4 py-2 text-center">
                          <Switch
                            size="sm"
                            checked={pages.includes(page.key)}
                            disabled={isPending}
                            onCheckedChange={() => toggle(page.key)}
                          />
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
      <Dialog
        open={confirmOpen}
        onOpenChange={(v) => {
          setConfirmOpen(v);
          if (!v) setTotpCode("");
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Save Permission Changes</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Granting or revoking permissions can change what this admin
              can do across the panel. Enter your 2FA code to confirm.
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
              onClick={() => {
                setConfirmOpen(false);
                setTotpCode("");
              }}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={isPending || !totpCode.trim()}
            >
              {isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
