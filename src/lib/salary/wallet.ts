import "server-only";

import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatEther,
  formatUnits,
  isAddress,
  parseUnits,
} from "ethers";

/**
 * Ethereum mainnet USDT contract. Standard tether deployment.
 * 6 decimal places (NOT 18 — tether is 6).
 */
export const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
export const USDT_DECIMALS = 6;

const ERC20_ABI = [
  // Read-only
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  // Write
  "function transfer(address to, uint256 amount) returns (bool)",
];

/**
 * Build a JSON-RPC provider. `rpcOverride` (the per-row rpc_url
 * column) wins so the user can hot-swap providers without a deploy;
 * env var `ETHEREUM_RPC_URL` is the next fallback; finally the
 * cloudflare public endpoint as a last-resort read fallback.
 *
 * For sends, ALWAYS pass a private rpcOverride / env var — public
 * RPCs throttle write traffic and don't reliably propagate txns.
 */
export function getProvider(rpcOverride?: string | null): JsonRpcProvider {
  const url =
    rpcOverride ||
    process.env.ETHEREUM_RPC_URL ||
    "https://cloudflare-eth.com";
  return new JsonRpcProvider(url);
}

/** Derive the public 0x-address for a private key. */
export function deriveAddress(privateKey: string): string {
  return new Wallet(normalizePrivateKey(privateKey)).address;
}

/** Accept "0x..." or bare "..." — ethers wants the 0x prefix. */
export function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

export function isValidPrivateKey(raw: string): boolean {
  try {
    new Wallet(normalizePrivateKey(raw));
    return true;
  } catch {
    return false;
  }
}

export { isAddress };

export type WalletSnapshot = {
  address: string;
  ethBalance: string; // formatted "0.0123"
  ethBalanceWei: bigint;
  usdtBalance: string; // formatted, 6 decimals
  usdtBalanceRaw: bigint;
  rpcUrl: string;
};

/**
 * Read both ETH (gas) + USDT balances in one round-trip.
 * Fails soft on RPC errors — UI shows the address with "—" balances
 * instead of crashing the page.
 */
export async function getWalletSnapshot(
  privateKey: string,
  rpcOverride?: string | null,
): Promise<WalletSnapshot> {
  const provider = getProvider(rpcOverride);
  const wallet = new Wallet(normalizePrivateKey(privateKey), provider);
  const usdt = new Contract(USDT_ADDRESS, ERC20_ABI, provider);

  const [ethBalanceWei, usdtBalanceRaw] = await Promise.all([
    provider.getBalance(wallet.address),
    usdt.balanceOf(wallet.address) as Promise<bigint>,
  ]);

  return {
    address: wallet.address,
    ethBalance: formatEther(ethBalanceWei),
    ethBalanceWei,
    usdtBalance: formatUnits(usdtBalanceRaw, USDT_DECIMALS),
    usdtBalanceRaw,
    rpcUrl:
      rpcOverride ||
      process.env.ETHEREUM_RPC_URL ||
      "https://cloudflare-eth.com",
  };
}

export type TransferResult =
  | { ok: true; txHash: string }
  | { ok: false; error: string };

/**
 * Sign + broadcast a USDT ERC-20 transfer. Returns as soon as the
 * tx is in the mempool — does NOT wait for confirmations. Caller
 * should poll receipts.
 *
 * Pre-flight checks done here:
 *   - destination is a valid address
 *   - amount > 0
 *   - wallet USDT balance ≥ amount
 *   - wallet ETH balance ≥ a small floor (gas reserve)
 *
 * Failures return `{ ok: false, error }` — never throw, so the
 * server action can map them to a result-as-value response.
 */
export async function transferUsdt(params: {
  privateKey: string;
  rpcOverride?: string | null;
  to: string;
  amountUsdt: number; // human-readable, e.g. 250.5
  // Min ETH the wallet must keep on hand for gas after the send.
  // Default ~0.005 ETH (~$15-25 depending on ETH price).
  ethReserve?: bigint;
}): Promise<TransferResult> {
  const { privateKey, rpcOverride, to, amountUsdt } = params;
  const reserve = params.ethReserve ?? parseUnits("0.005", 18); // 0.005 ETH

  if (!isAddress(to)) {
    return { ok: false, error: "Recipient is not a valid Ethereum address" };
  }
  if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
    return { ok: false, error: "Amount must be a positive number" };
  }

  const provider = getProvider(rpcOverride);
  const wallet = new Wallet(normalizePrivateKey(privateKey), provider);
  const usdt = new Contract(USDT_ADDRESS, ERC20_ABI, wallet);

  // Convert human "250.5" → on-chain integer (× 10^6 for USDT).
  const amountRaw = parseUnits(amountUsdt.toFixed(USDT_DECIMALS), USDT_DECIMALS);

  let usdtBalance: bigint;
  let ethBalance: bigint;
  try {
    [usdtBalance, ethBalance] = await Promise.all([
      usdt.balanceOf(wallet.address) as Promise<bigint>,
      provider.getBalance(wallet.address),
    ]);
  } catch (err) {
    return {
      ok: false,
      error: `RPC pre-flight failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (usdtBalance < amountRaw) {
    return {
      ok: false,
      error: `Insufficient USDT — wallet has ${formatUnits(usdtBalance, USDT_DECIMALS)}, needed ${formatUnits(amountRaw, USDT_DECIMALS)}`,
    };
  }
  if (ethBalance < reserve) {
    return {
      ok: false,
      error: `Wallet ETH ${formatEther(ethBalance)} is below the gas reserve of ${formatEther(reserve)} — top up before sending`,
    };
  }

  try {
    const tx = await usdt.transfer(to, amountRaw);
    return { ok: true, txHash: tx.hash };
  } catch (err) {
    return {
      ok: false,
      error: `Broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Poll a tx hash for a final receipt. Returns:
 *   - "confirmed" if status === 1
 *   - "failed" if status === 0
 *   - "pending" if not mined yet
 *
 * Single-shot — caller drives the polling cadence.
 */
export async function getTxStatus(
  txHash: string,
  rpcOverride?: string | null,
): Promise<"confirmed" | "failed" | "pending"> {
  const provider = getProvider(rpcOverride);
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return "pending";
    return receipt.status === 1 ? "confirmed" : "failed";
  } catch {
    return "pending";
  }
}
