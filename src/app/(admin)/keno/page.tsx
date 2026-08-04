import { redirect } from "next/navigation";
import { parseKenoTab } from "./tabs";

export const metadata = { title: "Keno" };

export default async function KenoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const tab = parseKenoTab((await searchParams).tab);
  redirect(`/analytics?tab=games&g=keno&kenoTab=${tab}`);
}
