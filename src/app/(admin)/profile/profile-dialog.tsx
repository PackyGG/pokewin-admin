"use client";

import * as React from "react";
import { User, Settings, KeyRound, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { SectionHeading } from "@/components/modern-panels";
import { ROLE_COLORS } from "@/lib/constants";
import type { AdminPreferences } from "@/lib/admin-preferences-types";
import { ProfileForm } from "./profile-form";
import { PreferencesForm } from "./preferences-form";
import { PasswordForm } from "./password-form";

// ---------------------------------------------------------------------------
// Profile dialog
// ---------------------------------------------------------------------------
//
// The entire self-service profile experience as a single responsive popup,
// opened from the avatar dropdown in the admin header. Replaces the old
// `/profile` route (deleted) — the server actions (display name / avatar /
// preferences / password) are unchanged and imported straight into the
// forms below.
//
// Three stacked, scrollable sections (Profile · Preferences · Security).
// Stacked-not-tabbed is deliberate: it stays legible and overflow-free at
// any width from ~360px phones up to large desktops, where horizontal tab
// strips get cramped. The shared <DialogContent> already provides the
// mobile bottom-sheet / desktop centered-modal geometry, the scroll
// container (`overflow-y-auto`, capped at 90vh / 85vh), and the safe-area
// padding; here we only widen the desktop cap to `sm:max-w-lg` so the
// preference grids (3-up theme / date-format tiles) have room to breathe.
// ---------------------------------------------------------------------------

export type ProfileDialogSection = "profile" | "security";

export type ProfileDialogData = {
  id: string;
  username: string;
  email: string;
  role: string;
  displayUsername: string | null;
  hasAvatar: boolean;
  profileFieldsAvailable: boolean;
  preferences: AdminPreferences;
};

export function ProfileDialog({
  open,
  onOpenChange,
  data,
  /**
   * Which section to bring into view when the dialog opens. The "Change
   * password" dropdown entry passes `"security"` so the user lands on the
   * password form; everything else opens at the top ("profile").
   */
  initialSection = "profile",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: ProfileDialogData;
  initialSection?: ProfileDialogSection;
}) {
  const securityRef = React.useRef<HTMLDivElement>(null);

  // When opened targeting the Security section, scroll it into view. We wait
  // a tick so the popup has mounted + laid out (the open animation is short;
  // scrolling immediately would target a zero-height element). Scroll the
  // inner ref into the scrollable DialogContent rather than the document.
  React.useEffect(() => {
    if (!open || initialSection !== "security") return;
    const id = window.setTimeout(() => {
      securityRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 120);
    return () => window.clearTimeout(id);
  }, [open, initialSection]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Widen the desktop cap from the default `sm:max-w-sm` so the
        // 3-column preference grids fit without wrapping awkwardly. Mobile
        // stays the full-width bottom sheet from the base component.
        className="sm:max-w-lg gap-0"
      >
        <DialogHeader className="pb-2">
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-cyan-500/10 ring-1 ring-inset ring-cyan-500/20">
              <User className="size-4 text-cyan-500" />
            </span>
            <span>My Profile</span>
            <Badge
              variant="outline"
              className={ROLE_COLORS[data.role] ?? ""}
            >
              {data.role}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            Update your display name, picture and preferences. Only you can
            edit your own profile.
          </DialogDescription>
        </DialogHeader>

        {!data.profileFieldsAvailable && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <span>
              Profile fields aren&apos;t enabled yet. Run{" "}
              <code className="rounded bg-muted px-1 py-0.5">
                npm run admin:migrate
              </code>{" "}
              to enable display name, picture and preferences editing.
            </span>
          </div>
        )}

        {/* Stacked sections. `min-w-0` on the wrapper + each section keeps
            long content (emails, IANA zone strings) from forcing horizontal
            overflow at narrow widths. */}
        <div className="mt-4 flex min-w-0 flex-col gap-7">
          <section className="min-w-0 space-y-3">
            <SectionHeading icon={User} title="Profile" />
            <ProfileForm
              adminId={data.id}
              username={data.username}
              email={data.email}
              role={data.role}
              displayUsername={data.displayUsername}
              hasAvatar={data.hasAvatar}
              profileFieldsAvailable={data.profileFieldsAvailable}
            />
          </section>

          <div className="border-t border-border" />

          <section className="min-w-0 space-y-3">
            <SectionHeading icon={Settings} title="Preferences" />
            <PreferencesForm
              initial={data.preferences}
              profileFieldsAvailable={data.profileFieldsAvailable}
            />
          </section>

          <div className="border-t border-border" />

          <section ref={securityRef} className="min-w-0 scroll-mt-4 space-y-3">
            <SectionHeading icon={KeyRound} title="Security" />
            <p className="text-xs text-muted-foreground">
              Change your password. Requires your current password and a 2FA
              code. Only affects your own account.
            </p>
            <PasswordForm />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
