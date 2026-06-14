import { User, Settings, AlertTriangle, KeyRound } from "lucide-react";
import { verifySession } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHero, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { ROLE_COLORS } from "@/lib/constants";
import { ProfileForm } from "./profile-form";
import { PreferencesForm } from "./preferences-form";
import { PasswordForm } from "./password-form";
import { getAdminPreferences } from "@/lib/admin-preferences";

export const metadata = { title: "My Profile" };

type AdminProfileData = {
  id: string;
  username: string;
  email: string;
  role: string;
  display_username: string | null;
  hasAvatar: boolean;
  profileFieldsAvailable: boolean;
};

async function loadProfile(userId: string): Promise<AdminProfileData> {
  try {
    const user = await adminDb.admin_users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        display_username: true,
        profile_image_mime: true,
      },
    });
    if (!user) {
      // Shouldn't happen — verifySession already checked the row exists.
      throw new Error("Admin user not found");
    }
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      display_username: user.display_username,
      hasAvatar: Boolean(user.profile_image_mime),
      profileFieldsAvailable: true,
    };
  } catch (err) {
    // Pre-migration graceful fallback: re-query without the profile columns.
    const code = (err as { code?: string })?.code;
    const missingColumn =
      code === "P2022" ||
      (err instanceof Error && /column .* does not exist/i.test(err.message));
    if (!missingColumn) throw err;

    const user = await adminDb.admin_users.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true, role: true },
    });
    if (!user) throw new Error("Admin user not found");
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      display_username: null,
      hasAvatar: false,
      profileFieldsAvailable: false,
    };
  }
}

export default async function ProfilePage() {
  const session = await verifySession();
  const profile = await loadProfile(session.userId);
  const preferences = await getAdminPreferences(session.userId);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-cyan-500/10">
            <User className="size-5 text-cyan-500" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold leading-tight">My Profile</h1>
              <Badge
                variant="outline"
                className={ROLE_COLORS[profile.role] ?? ""}
              >
                {profile.role}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Update your display name and profile picture. Only you can edit
              your profile.
            </p>
          </div>
        </div>
      </PageHero>

      {!profile.profileFieldsAvailable && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-500" />
              Profile fields not enabled
            </CardTitle>
            <CardDescription>
              The database migration that adds profile fields hasn&apos;t been
              applied yet. Run <code className="rounded bg-muted px-1 py-0.5 text-xs">npm run admin:migrate</code> to
              enable display name and profile picture editing.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <FadeIn className="space-y-6">
        <div className="space-y-3">
          <SectionHeading icon={User} title="Profile" />
          <Card>
            <CardHeader>
              <CardDescription>
                Shown next to your username across the admin panel.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ProfileForm
                adminId={profile.id}
                username={profile.username}
                email={profile.email}
                role={profile.role}
                displayUsername={profile.display_username}
                hasAvatar={profile.hasAvatar}
                profileFieldsAvailable={profile.profileFieldsAvailable}
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-3">
          <SectionHeading icon={Settings} title="Preferences" />
          <Card>
            <CardHeader>
              <CardDescription>
                Theme, timezone and date format. Only affects your own view.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PreferencesForm
                initial={preferences}
                profileFieldsAvailable={profile.profileFieldsAvailable}
              />
            </CardContent>
          </Card>
        </div>

        <div id="security" className="scroll-mt-20 space-y-3">
          <SectionHeading icon={KeyRound} title="Security" />
          <Card>
            <CardHeader>
              <CardDescription>
                Change your password. Requires your current password and a 2FA
                code. Only affects your own account.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PasswordForm />
            </CardContent>
          </Card>
        </div>
      </FadeIn>
    </div>
  );
}
