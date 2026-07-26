import { canUseStaffProfile, requireStaffPage } from "@/lib/staff/access";
import { ensureStaffProfile } from "@/lib/staff/profile";

export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireStaffPage();
  if (canUseStaffProfile(session)) {
    await ensureStaffProfile(session.userId);
  }
  return children;
}
