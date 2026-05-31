"use server";

import { requirePageAccess } from "@/lib/dal";
import { getTransactionDetail } from "@/lib/queries/transactions";

/**
 * Server-side fetch for the click-an-ID popup on /transactions/upgrader.
 *
 * Reuses `getTransactionDetail` so the popup and the full
 * /transactions/[id] page can never drift apart — same PF rolls, same
 * card-hit chip, same numbers. Gate uses /transactions/upgrader since
 * that's the surface the popup opens from; any admin who can reach
 * the list can see the corresponding transaction's PF detail without
 * needing a separate permission grant.
 *
 * Returns null when the ledger tx id is unknown — the dialog renders
 * a tiny "not found" state instead of throwing.
 */
export async function getUpgraderTxDialogDetails(ledgerTxId: string) {
  await requirePageAccess("/transactions/upgrader");
  return await getTransactionDetail(ledgerTxId);
}
