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
// Solana public keys are base58-encoded (Bitcoin alphabet — no 0, O, I,
// l) and decode to 32 bytes, which renders as 32-44 base58 chars.
const SOL_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Which chain an address belongs to, derived purely from its format. */
export type AddressKind = "erc20" | "sol" | "unknown";

/**
 * Classify an address by format alone. ERC-20 is checked first; its
 * `0x` prefix can never satisfy the base58 SOL pattern, so the two are
 * mutually exclusive.
 */
export function addressKind(value: string): AddressKind {
  const v = value.trim();
  if (ETH_ADDRESS_RE.test(v)) return "erc20";
  if (SOL_ADDRESS_RE.test(v)) return "sol";
  return "unknown";
}

/** True for any address we recognise (ERC-20 or Solana). */
export function isAddress(value: string): boolean {
  return addressKind(value) !== "unknown";
}

/** Build a mainnet Etherscan URL for an address. */
function etherscanAddressUrl(address: string): string {
  return `https://etherscan.io/address/${address}`;
}

/** Build a mainnet Etherscan URL for a transaction hash. */
function etherscanTxUrl(txHash: string): string {
  return `https://etherscan.io/tx/${txHash}`;
}

/**
 * Normalize an address for storage. ERC-20 addresses are
 * case-insensitive hex → lowercased so equality checks (audit
 * metadata, dedup) don't need checksum-aware compares. Solana
 * addresses are case-SENSITIVE base58 → stored verbatim (lowercasing
 * would corrupt the key), only trimmed.
 */
export function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  return ETH_ADDRESS_RE.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}
