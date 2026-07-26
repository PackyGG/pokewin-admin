import { verifySession } from "@/lib/dal";
import { canUseStaffProfile } from "@/lib/staff/access";
import { StaffPresence } from "./_components/staff-presence";

export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await verifySession();
  return (
    <>
      {canUseStaffProfile(session) && <StaffPresence />}
      {children}
    </>
  );
}
