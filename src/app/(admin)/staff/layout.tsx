import { requireStaffPage } from "@/lib/staff/access";
import { ensureStaffProfile } from "@/lib/staff/profile";

export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireStaffPage();
  await ensureStaffProfile(session.userId);
  return children;
}
