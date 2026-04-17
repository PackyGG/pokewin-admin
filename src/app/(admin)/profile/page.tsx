import { verifySession } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ProfileForm } from "./profile-form";

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

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">My Profile</h1>
        <p className="text-sm text-muted-foreground">
          Update your display name and profile picture. Only you can edit your profile.
        </p>
      </div>

      {!profile.profileFieldsAvailable && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profile fields not enabled</CardTitle>
            <CardDescription>
              The database migration that adds profile fields hasn&apos;t been
              applied yet. Run <code className="rounded bg-muted px-1 py-0.5 text-xs">npm run admin:migrate</code> to
              enable display name and profile picture editing.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
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
  );
}
