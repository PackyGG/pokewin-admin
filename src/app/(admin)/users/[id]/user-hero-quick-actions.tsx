"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Banknote, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BalanceAdjustDialog } from "./user-tabs-dialogs";
import type { UserDetail } from "./user-tabs-types";

/**
 * Compact quick-action cluster surfaced in the hero so an operator can
 * reach the most common admin actions without scrolling into a tab.
 *
 * Reuses EXISTING, already-wired components — no new mutations:
 *   • Adjust Balance → the canonical {@link BalanceAdjustDialog} (controlled
 *     open/onOpenChange), which calls the existing `adjustBalance` server
 *     action with full 2FA + category validation. Gated on
 *     `capabilities.canAdjustBalance`.
 *   • Add Note → jumps to the Account tab (where {@link NotesSection} lives,
 *     gated behind its own tab-kicked notes fetch). We deliberately DON'T
 *     re-mount NotesSection here: that would need an always-kicked notes
 *     query, breaking Active-Timeframe-Only. The jump reuses the existing
 *     tab switch + URL write.
 *   • Tags → the {@link UserTagsPanel} select/deselect dropdown, threaded in
 *     as a serializable `tagsSlot` ReactNode from page.tsx so it sits next to
 *     Add Note. It owns its own gating + the existing tag server actions.
 *
 * Ban/unban/lock/vault already render via {@link UserAdminActions} elsewhere
 * in the hero toolbar, so they're not duplicated here.
 */
export function HeroQuickActions({
  user,
  availableBalance,
  availableBalanceRaw,
  lockedBalance,
  canAdjustBalance,
  onOpenAccount,
  tagsSlot,
}: {
  user: UserDetail["user"];
  availableBalance: number;
  availableBalanceRaw: number;
  lockedBalance: number;
  canAdjustBalance: boolean;
  /** Switches the view to the Account tab (where Admin Notes live). */
  onOpenAccount: () => void;
  /** Pre-rendered VIP tag dropdown (UserTagsPanel) — sits next to Add note. */
  tagsSlot?: ReactNode;
}) {
  const [adjustOpen, setAdjustOpen] = useState(false);

  if (!canAdjustBalance) {
    // Without balance-adjust, the remaining quick actions are the note jump
    // + the tags dropdown — kept together in one compact cluster.
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onOpenAccount}
          title="Jump to Admin Notes (Account tab)"
        >
          <StickyNote className="size-3.5" /> Add note
        </Button>
        {tagsSlot}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 border-blue-500/40 text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
        onClick={() => setAdjustOpen(true)}
        title="Adjust this user's balance"
      >
        <Banknote className="size-3.5" /> Adjust balance
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={onOpenAccount}
        title="Jump to Admin Notes (Account tab)"
      >
        <StickyNote className="size-3.5" /> Add note
      </Button>
      {/* Tags dropdown — sits next to Add note per owner. */}
      {tagsSlot}

      <BalanceAdjustDialog
        userId={user.id}
        availableBalance={availableBalance}
        availableBalanceRaw={availableBalanceRaw}
        lockedBalance={lockedBalance}
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
      />
    </div>
  );
}
