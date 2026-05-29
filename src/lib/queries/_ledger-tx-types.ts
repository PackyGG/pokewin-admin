import {
  ledger_transaction_type,
  type ledger_transaction_type as LedgerTransactionType,
} from "@/generated/prisma/enums";

/** Generated Prisma enum values — keep queries in sync with schema.prisma. */
export const LEDGER_TX_TYPES = new Set<string>(Object.values(ledger_transaction_type));

/** Drop strings that are not in the generated client (e.g. after schema drift before `prisma generate`). */
export function filterLedgerTxTypes(types: readonly string[]): LedgerTransactionType[] {
  return types.filter((t): t is LedgerTransactionType => LEDGER_TX_TYPES.has(t));
}
