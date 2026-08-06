import { redirect } from "next/navigation";

export const metadata = { title: "Fiat Deposit Reviews" };

export default function LegacyFiatDepositReviewsPage() {
  redirect("/antifraud/fiat-deposits");
}
