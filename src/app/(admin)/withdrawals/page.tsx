import { redirect, RedirectType } from "next/navigation";

export const metadata = { title: "Withdrawals" };

/**
 * /withdrawals is now a stub that funnels into the unified Transactions
 * page at `/transactions/deposits?tab=withdrawals`. The combined page
 * embeds the same toolbar (Status / Method / value-range), the same
 * data-table, and the same row actions — only the URL changed.
 *
 * Existing bookmarks, sidebar history, command-palette entries, and
 * external links keep working through this redirect. The `/withdrawals`
 * permission key in `admin-pages.ts` is retained so support users who
 * had explicit withdrawals access still pass `requirePageAccess`
 * upstream; the combined page itself gates on
 * `/transactions/deposits`.
 *
 * Uses `RedirectType.replace` so the back button skips the stub —
 * admins who hit it from a stale bookmark don't get a no-op stuck
 * in their history.
 */
export default async function WithdrawalsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  // Carry forward any existing query string so a deep-link like
  // /withdrawals?status=pending&minValue=100 still applies its filters
  // on the new surface. Filter param names (status / method / minValue
  // / maxValue / search) are identical on both pages so a verbatim
  // forward works.
  const search = new URLSearchParams();
  search.set("tab", "withdrawals");
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "" && k !== "tab") search.set(k, v);
  }
  redirect(`/transactions/deposits?${search.toString()}`, RedirectType.replace);
}
