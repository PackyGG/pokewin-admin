import { timingSafeEqual } from "node:crypto";

import type { Config } from "./config.js";

function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function serviceRequestAuthorized(
  method: string,
  pathname: string,
  token: string,
  config: Pick<Config, "API_TOKEN" | "API_ADMIN_TOKEN">,
): boolean {
  const needsAdminToken =
    (method === "PUT" && pathname.startsWith("/v1/rules/")) ||
    (method === "POST" && pathname.includes("/decision"));
  return needsAdminToken
    ? safeTokenEqual(token, config.API_ADMIN_TOKEN)
    : safeTokenEqual(token, config.API_TOKEN) ||
      safeTokenEqual(token, config.API_ADMIN_TOKEN);
}
