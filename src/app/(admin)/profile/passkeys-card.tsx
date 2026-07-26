"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Fingerprint, Plus, Trash2, Pencil, Check, X } from "lucide-react";
import {
  startRegistration,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ux";
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
import { formatDate } from "@/lib/utils/format";
import {
  PASSKEY_STALE_BODY,
  isPasskeyFromOldDomain,
} from "@/lib/passkey-migration";
import {
  listMyPasskeys,
  startPasskeyRegistration,
  finishPasskeyRegistration,
  renamePasskey,
  deletePasskey,
  type PasskeySummary,
} from "./passkey-actions";

// Mirrors MAX_PASSKEYS_PER_ADMIN in passkey-actions.ts (the server is the
// source of truth; this is only for UX — disabling the add control + hint).
const MAX_PASSKEYS_PER_ADMIN = 2;

/**
 * Self-service passkey management, slotted into the Security section of the
 * profile dialog. A registered passkey works as an ALTERNATIVE to the TOTP code
 * at the 2FA step (password + TOTP enrollment are unchanged). The list is
 * loaded lazily the first time the dialog is opened (`active`) so it never
 * fires on every page render while the dialog sits mounted-but-closed.
 */
export function PasskeysCard({ active }: { active: boolean }) {
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPasskeys(await listMyPasskeys());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load passkeys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active && !loadedRef.current) {
      loadedRef.current = true;
      void load();
    }
  }, [active, load]);

  const atLimit = (passkeys?.length ?? 0) >= MAX_PASSKEYS_PER_ADMIN;

  async function handleAdd() {
    if (atLimit) {
      toast.error(
        `You can have at most ${MAX_PASSKEYS_PER_ADMIN} passkeys. Remove one to add another.`,
      );
      return;
    }
    if (!browserSupportsWebAuthn()) {
      toast.error("This browser does not support passkeys.");
      return;
    }
    setAdding(true);
    try {
      const optionsJSON = await startPasskeyRegistration();
      const response = await startRegistration({ optionsJSON });
      await finishPasskeyRegistration(response, newName.trim() || undefined);
      toast.success("Passkey added");
      setNewName("");
      await load();
    } catch (err) {
      // The browser throws a DOMException when the user cancels the prompt —
      // surface a soft message rather than a scary error.
      if (err instanceof Error && err.name === "NotAllowedError") {
        toast.error("Passkey setup was cancelled.");
      } else {
        toast.error(err instanceof Error ? err.message : "Could not add passkey");
      }
    } finally {
      setAdding(false);
    }
  }

  async function handleRename(id: string) {
    try {
      await renamePasskey(id, editName);
      setEditingId(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rename passkey");
    }
  }

  async function handleDelete(id: string) {
    try {
      await deletePasskey(id);
      toast.success("Passkey removed");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove passkey");
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Add a passkey (Face ID, Touch ID, Windows Hello, or a security key) to
        use instead of your authenticator code when you sign in. Your password
        is still required.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value.slice(0, 60))}
          placeholder="Device name (optional)"
          disabled={adding || atLimit}
          className="sm:max-w-[220px]"
        />
        <Button
          type="button"
          size="sm"
          onClick={handleAdd}
          disabled={adding || atLimit}
        >
          {adding ? (
            <Spinner size={14} className="text-current" />
          ) : (
            <Plus className="size-4" />
          )}
          {adding ? "Waiting for device..." : "Add passkey"}
        </Button>
      </div>

      {atLimit && (
        <p className="text-xs text-muted-foreground">
          You&apos;ve reached the limit of {MAX_PASSKEYS_PER_ADMIN} passkeys.
          Remove one below to add another.
        </p>
      )}

      <div className="space-y-2">
        {loading && passkeys === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size={14} /> Loading passkeys...
          </div>
        ) : passkeys && passkeys.length > 0 ? (
          passkeys.map((pk) => (
            <div
              key={pk.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-card/40 p-3"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 ring-1 ring-inset ring-cyan-500/20">
                <Fingerprint className="size-4 text-cyan-500" />
              </span>

              <div className="min-w-0 flex-1">
                {editingId === pk.id ? (
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value.slice(0, 60))}
                      placeholder="Device name"
                      className="h-8"
                      autoFocus
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-8 shrink-0"
                      onClick={() => handleRename(pk.id)}
                      aria-label="Save name"
                    >
                      <Check className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-8 shrink-0"
                      onClick={() => setEditingId(null)}
                      aria-label="Cancel"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {pk.deviceName || "Unnamed passkey"}
                      </span>
                      {pk.backedUp && (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
                        >
                          Synced
                        </Badge>
                      )}
                      {/* A credential created before the packydash.com RP-ID
                          cutover is bound to the old domain — the browser won't
                          offer it here. Say so BEFORE it fails at sign-in. */}
                      {isPasskeyFromOldDomain(pk.createdAt) && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400"
                        >
                          Needs re-adding
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      Added {formatDate(pk.createdAt)}
                      {pk.lastUsedAt
                        ? ` · Last used ${formatDate(pk.lastUsedAt)}`
                        : " · Never used"}
                    </p>
                    {isPasskeyFromOldDomain(pk.createdAt) && (
                      <p className="mt-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                        {PASSKEY_STALE_BODY}
                      </p>
                    )}
                  </>
                )}
              </div>

              {editingId !== pk.id && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8 text-muted-foreground"
                    onClick={() => {
                      setEditingId(pk.id);
                      setEditName(pk.deviceName ?? "");
                    }}
                    aria-label="Rename passkey"
                  >
                    <Pencil className="size-4" />
                  </Button>

                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-8 text-rose-500 hover:text-rose-600"
                          aria-label="Remove passkey"
                        />
                      }
                    >
                      <Trash2 className="size-4" />
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove this passkey?</AlertDialogTitle>
                        <AlertDialogDescription>
                          You will no longer be able to use{" "}
                          <span className="font-medium">
                            {pk.deviceName || "this passkey"}
                          </span>{" "}
                          to sign in. Your authenticator app still works.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleDelete(pk.id)}
                          className="bg-rose-600 text-white hover:bg-rose-700"
                        >
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              )}
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No passkeys yet. Add one above to sign in faster.
          </p>
        )}
      </div>
    </div>
  );
}
