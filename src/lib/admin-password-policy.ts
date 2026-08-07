import { z } from "zod";

export const ADMIN_PASSWORD_MIN_LENGTH = 10;
export const ADMIN_PASSWORD_MAX_BYTES = 72;
export const ADMIN_PASSWORD_BCRYPT_COST = 12;

export const adminPasswordSchema = z
  .string()
  .min(
    ADMIN_PASSWORD_MIN_LENGTH,
    `New password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`,
  )
  .refine(
    (password) =>
      new TextEncoder().encode(password).byteLength <=
      ADMIN_PASSWORD_MAX_BYTES,
    `New password must be at most ${ADMIN_PASSWORD_MAX_BYTES} UTF-8 bytes`,
  );
