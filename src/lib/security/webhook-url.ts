import "server-only";

/**
 * SSRF egress guard for outbound webhook URLs.
 *
 * Webhook destinations are attacker-influenced — a creator sets their own URL
 * through the self-service (`my-profile`) and admin (`creators`) webhook
 * actions — and the server later POSTs to them (test + `balance_fill` +
 * `deal_data` dispatch). Without this guard a URL like
 * `http://169.254.169.254/…` or `http://127.0.0.1:PORT/` turns those actions
 * into a server-side request-forgery primitive against the internal network /
 * cloud metadata. Validate at STORE time (create/update) and again defensively
 * before each fetch.
 *
 * Scope: allows http/https to a PUBLIC host only. Blocks non-http(s) schemes,
 * loopback/private/link-local/CGNAT IP literals (incl. IPv6 + IPv4-mapped +
 * integer/hex shorthands), and obvious internal hostnames.
 *
 * Residual (documented, not yet covered): this inspects the host string only —
 * it does NOT resolve DNS, so a PUBLIC hostname that resolves to a private IP
 * (DNS rebinding) is not caught here. Store-time validation blocks the common
 * literal vectors; pinning the resolved IP at connect time is a follow-up.
 */

function ipv4ToParts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5).map((n) => Number(n));
  if (parts.some((n) => n < 0 || n > 255)) return null;
  return parts;
}

/** True for loopback / private / link-local / CGNAT / "this host" IPv4. */
function isBlockedIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (metadata)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;

  // Obvious internal hostnames.
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;

  // IPv6 literal (URL.hostname keeps brackets for IPv6).
  if (host.includes(":")) {
    const h = host.replace(/^\[/, "").replace(/\]$/, "");
    if (h === "::1" || h === "::") return true; // loopback / unspecified
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
    if (mapped) {
      const p = ipv4ToParts(mapped[1]);
      return p ? isBlockedIpv4(p) : true;
    }
    const first = h.split(":")[0];
    if (/^f[cd]/.test(first)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(first)) return true; // fe80::/10 link-local
    return false;
  }

  // Hex-encoded IP (e.g. 0x7f000001 = 127.0.0.1).
  if (/^0x[0-9a-f]+$/i.test(host)) return true;

  // Dotted / integer numeric forms. A valid full dotted-quad is range-checked;
  // any other all-numeric form (integer "2130706433", short "127.1") is a
  // non-standard IP encoding a real webhook host never uses → block.
  if (/^[0-9.]+$/.test(host)) {
    const v4 = ipv4ToParts(host);
    return v4 ? isBlockedIpv4(v4) : true;
  }

  // Normal public hostname.
  return false;
}

/**
 * Throw with a caller-safe message when `raw` is not a webhook URL we are
 * willing to POST to from the server. Use at store time (create/update).
 */
export function assertSafeWebhookUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid webhook URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Webhook URL must use http or https");
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error("Webhook URL host is not allowed (private / internal address)");
  }
}

/** Non-throwing variant for fetch-time defense-in-depth on already-stored URLs. */
export function isSafeWebhookUrl(raw: string): boolean {
  try {
    assertSafeWebhookUrl(raw);
    return true;
  } catch {
    return false;
  }
}
