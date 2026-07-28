import { redirect } from "next/navigation";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";

export const metadata = { title: "Point Flows · Antifraud" };

export default async function AntifraudFlowsPage() {
  await requireAntifraudManagerPage();
  redirect("/antifraud/points?tab=flows");
}
