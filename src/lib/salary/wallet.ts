import "server-only";

/**
 * What used to be a full ethers + USDT contract module. The auto-
 * payment system was removed (motha sends USDT manually from their
 * own wallet now), so this file only carries the address-validation
 * helper still needed at action boundaries.
 *
 * Etherscan link helper also lives here so the salary UI doesn't
 * have to repeat the URL prefix.
 */

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Mainnet Ethereum address format validator. */
export function isAddress(value: string): boolean {
  return ETH_ADDRESS_RE.test(value.trim());
}

/** Build a mainnet Etherscan URL for an address. */
export function etherscanAddressUrl(address: string): string {
  return `https://etherscan.io/address/${address}`;
}

/** Build a mainnet Etherscan URL for a transaction hash. */
export function etherscanTxUrl(txHash: string): string {
  return `https://etherscan.io/tx/${txHash}`;
}

/**
 * 0x-prefix and lowercase normalize an address. We validate FIRST
 * with isAddress, then store lowercase so equality checks elsewhere
 * (audit metadata, dedup) don't need to checksum-aware compare.
 */
export function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase();
}
