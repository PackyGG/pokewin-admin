import { canUseStaffProfile, requireStaffPage } from "@/lib/staff/access";
import { StaffPresence } from "./_components/staff-presence";

export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireStaffPage();
  return (
    <>
      {canUseStaffProfile(session) && <StaffPresence />}
      {children}
    </>
  );
}
