import { TOTP, Secret } from "otpauth";

/**
 * Generate a valid current TOTP code for the seeded E2E admin.
 *
 * We deliberately match the parameters used by `src/lib/totp.ts` so any
 * code we generate here verifies against the server's otpauth validator:
 *   - SHA1, 30s period, 6 digits, window ±1
 *
 * Tests should always re-generate the code at the moment they need it.
 * TOTP codes roll every 30 seconds; grabbing one up-front and typing it
 * later is a flake magnet.
 */
export function currentTotp(secret: string): string {
  const totp = new TOTP({
    issuer: "Packy.gg Admin",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
  return totp.generate();
}

/**
 * Read the E2E admin's TOTP secret from env. Fails loudly if missing —
 * tests need a deterministic secret to be useful, and silently falling
 * back to a random one would make them non-deterministic.
 */
export function getE2EAdminTotpSecret(): string {
  const secret = process.env.E2E_ADMIN_TOTP_SECRET;
  if (!secret) {
    throw new Error(
      "E2E_ADMIN_TOTP_SECRET is not set. Run `npm run test:e2e:seed` first " +
        "and copy the printed secret into your .env.local.",
    );
  }
  return secret;
}
