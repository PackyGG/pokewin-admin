"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Code, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { addAffiliateCode, removeAffiliateCode } from "./actions";

type Code = { id: string; code: string };

/**
 * Inline editor for a creator's owned affiliate codes — opens as a
 * popover from the table row so admins can see the full list +
 * add/remove without leaving /creators. The trigger displays the
 * count and the primary code so the column conveys useful info even
 * before clicking.
 *
 * Wraps the existing addAffiliateCode / removeAffiliateCode server
 * actions (already authed via requireCapability + audit-logged).
 * Toggle isn't exposed because the underlying column doesn't exist
 * in prod — see the comment in actions.ts:toggleAffiliateCode.
 */
export function InlineCodes({
  userId,
  codes,
}: {
  userId: string;
  codes: Code[];
}) {
  const [open, setOpen] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [isPending, startTransition] = useTransition();

  const summary =
    codes.length === 0
      ? "No codes"
      : codes.length === 1
        ? codes[0].code
        : `${codes[0].code} +${codes.length - 1}`;

  function handleAdd() {
    const trimmed = newCode.trim();
    if (!trimmed) {
      toast.error("Enter a code");
      return;
    }
    startTransition(async () => {
      try {
        await addAffiliateCode(userId, trimmed);
        toast.success(`Code "${trimmed}" added`);
        setNewCode("");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to add code");
      }
    });
  }

  function handleRemove(codeId: string, codeLabel: string) {
    startTransition(async () => {
      try {
        await removeAffiliateCode(codeId);
        toast.success(`Code "${codeLabel}" removed`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to remove code");
      }
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 font-mono text-xs"
            aria-label="Manage affiliate codes"
          />
        }
      >
        <Code className="size-3.5 text-muted-foreground" />
        <span className="truncate">{summary}</span>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        <div className="space-y-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Owned codes
            </p>
            <p className="text-[10px] text-muted-foreground">
              Oldest first. The first row is the primary code.
            </p>
          </div>

          {/* Code list */}
          <div className="space-y-1">
            {codes.length === 0 ? (
              <p className="rounded-md border border-dashed border-border/60 px-2 py-3 text-center text-xs text-muted-foreground">
                No codes minted yet.
              </p>
            ) : (
              codes.map((c, i) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2 py-1.5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-xs font-semibold">
                      {c.code}
                    </span>
                    {i === 0 && (
                      <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary">
                        Primary
                      </span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 text-muted-foreground hover:text-rose-500"
                    onClick={() => handleRemove(c.id, c.code)}
                    disabled={isPending}
                    aria-label={`Remove ${c.code}`}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              ))
            )}
          </div>

          {/* Add form */}
          <div className="space-y-1.5 border-t border-border/60 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Add new code
            </p>
            <div className="flex gap-1.5">
              <Input
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAdd();
                  }
                }}
                placeholder="newcode"
                className="h-7 font-mono text-xs"
                maxLength={32}
                disabled={isPending}
              />
              <Button
                size="sm"
                className="h-7 shrink-0 px-2"
                onClick={handleAdd}
                disabled={isPending || !newCode.trim()}
              >
                <Plus className="size-3.5" />
                Add
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Lowercased, must be unique across all creators.
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
