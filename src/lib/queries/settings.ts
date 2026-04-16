import { db } from "@/lib/db";

export async function getSettings() {
  const [vaultLockTimes, countryRestrictions, maintenanceConfig] = await Promise.all([
    db.vault_lock_times.findMany({ orderBy: { hours: "asc" } }),
    db.country_restrictions.findMany({ orderBy: { country_code: "asc" } }),
    db.site_config.findMany({
      where: { key: { in: ["maintenance_mode", "maintenance_message"] } },
      select: { key: true, value: true },
    }),
  ]);

  const maintenanceMap = new Map(maintenanceConfig.map((r) => [r.key, r.value]));

  return {
    vaultLockTimes: vaultLockTimes.map((v) => ({
      id: v.id,
      hours: v.hours,
      label: v.label,
    })),
    countryRestrictions: countryRestrictions.map((c) => ({
      countryCode: c.country_code,
      physicalWithdrawal: c.physical_withdrawal,
      digitalWithdrawal: c.digital_withdrawal,
      giftCardDeposit: c.gift_card_deposit,
      promoCodeDeposit: c.promo_code_deposit,
      blocked: c.blocked,
      lockedDepositsCrypto: c.locked_deposits_crypto,
      lockedDepositsFiat: c.locked_deposits_fiat,
      lockedWithdrawalsCrypto: c.locked_withdrawals_crypto,
    })),
    maintenance: {
      enabled: maintenanceMap.get("maintenance_mode") === "true",
      message: maintenanceMap.get("maintenance_message") ?? "",
    },
  };
}
