import { getDb } from "@/lib/db";

export type CountryRestrictionRow = {
  countryCode: string;
  physicalWithdrawal: boolean;
  digitalWithdrawal: boolean;
  giftCardDeposit: boolean;
  promoCodeDeposit: boolean;
  blocked: boolean;
  lockedDepositsCrypto: string[];
  lockedDepositsFiat: string[];
  lockedWithdrawalsCrypto: string[];
};

/**
 * Geo Blocking — per-country restriction rows for the
 * /system/geo-blocking page (formerly the "Country Restrictions" section of
 * /settings). Same MAIN-DB source the old `getSettings` read used:
 * `country_restrictions` ordered by ascending country code. Read-only.
 */
export async function getCountryRestrictions(): Promise<CountryRestrictionRow[]> {
  const db = await getDb();
  const rows = await db.country_restrictions.findMany({
    orderBy: { country_code: "asc" },
  });

  return rows.map((c) => ({
    countryCode: c.country_code,
    physicalWithdrawal: c.physical_withdrawal,
    digitalWithdrawal: c.digital_withdrawal,
    giftCardDeposit: c.gift_card_deposit,
    promoCodeDeposit: c.promo_code_deposit,
    blocked: c.blocked,
    lockedDepositsCrypto: c.locked_deposits_crypto,
    lockedDepositsFiat: c.locked_deposits_fiat,
    lockedWithdrawalsCrypto: c.locked_withdrawals_crypto,
  }));
}
