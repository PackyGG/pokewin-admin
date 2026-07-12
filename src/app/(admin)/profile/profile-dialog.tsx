"use client";

import * as React from "react";
import { User, Settings, KeyRound, AlertTriangle, Fingerprint } from "lucide-react";
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
import { PasskeysCard } from "./passkeys-card";

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
// Three sections (Profile · Preferences · Security). On large screens they
// lay out side-by-side — Profile + Security share a two-column row and the
// wider Preferences section (4-up theme tiles, timezone picker) spans the
// full width below — so the dialog reads as a compact panel instead of one
// long scroll. Below lg it collapses back to a single legible column,
// overflow-free from ~360px phones up. The shared <DialogContent> provides
// the mobile bottom-sheet / desktop centered-modal geometry, the scroll
// container (`overflow-y-auto`, capped at 90vh / 85vh) and the safe-area
// padding; here we widen the desktop cap (`sm:max-w-4xl`) to make room for
// the two-column layout and lift the surface to `bg-card` for a brighter,
// crisper panel.
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
   * Which section to bring into view when the dialog opens. The "Security"
   * dropdown entry passes `"security"` so the user lands on the password +
   * passkeys section; everything else opens at the top ("profile").
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
        // Wide desktop cap so the sections sit side-by-side (Profile +
        // Security in a two-column row, Preferences full-width below) instead
        // of one tall scroll. `bg-card` + `ring-border` lift the surface a
        // shade above the page for a brighter, crisper panel — both semantic
        // tokens, so light / dark / grailed all stay correct. Mobile stays
        // the full-width bottom sheet from the base component.
        className="sm:max-w-4xl gap-0 bg-card ring-border"
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

        {/* Side-by-side layout. On lg+ the two narrow-friendly sections
            (Profile + Security) share a two-column row and the wider
            Preferences section spans the full width beneath them — far less
            vertical scrolling than the old single stack. Below lg everything
            collapses back to one column with dividers between sections.
            `min-w-0` on the grid + each section keeps long content (emails,
            IANA zone strings) from forcing horizontal overflow at narrow
            widths. */}
        {/* Each section is its own bordered panel so the layout reads as
            tidy, aligned cards instead of free-floating columns with ragged
            heights (owner 2026-07-12: "not aligned / clean, dif heights").
            Profile + Security share a two-column row on lg+; the wider
            Preferences panel spans the full width beneath. Uniform gap +
            per-panel padding replace the old hand-drawn dividers. `min-w-0`
            keeps long content (emails, IANA zones) from overflowing. */}
        <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
          <section className="min-w-0 space-y-3 rounded-xl border border-border/60 p-4">
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

          <section
            ref={securityRef}
            className="min-w-0 scroll-mt-4 space-y-3 rounded-xl border border-border/60 p-4"
          >
            <SectionHeading icon={KeyRound} title="Security" />
            <p className="text-xs text-muted-foreground">
              Change your password. Requires your current password and a 2FA
              code. Only affects your own account.
            </p>
            <PasswordForm />

            <div className="mt-6 border-t border-border pt-5">
              <SectionHeading icon={Fingerprint} title="Passkeys" />
              <div className="mt-3">
                <PasskeysCard active={open} />
              </div>
            </div>
          </section>

          <section className="min-w-0 space-y-3 rounded-xl border border-border/60 p-4 lg:col-span-2">
            <SectionHeading icon={Settings} title="Preferences" />
            <PreferencesForm
              initial={data.preferences}
              profileFieldsAvailable={data.profileFieldsAvailable}
            />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
