import assert from "node:assert/strict";
import test from "node:test";

import { FiatDepositAccessClient } from "../src/fiat-deposit-access.js";

const config = {
  FIAT_ACCESS_API_BASE_URL: "https://packy.gg/v1/",
  ADMIN_API_KEY: "admin-key",
  xbypasssecret: "bypass-secret",
};

test("per-user Fiat access uses and confirms the backend controller contract", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const client = new FiatDepositAccessClient(config, async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return Response.json({
      success: true,
      data: { user_id: "user/123", enabled: true },
    });
  });

  assert.equal(await client.update("user/123", true), true);
  assert.equal(
    requestUrl,
    "https://packy.gg/v1/admin/users/user%2F123/fiat-deposit-access",
  );
  assert.equal(requestInit?.method, "PUT");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { enabled: true });
  assert.equal(
    (requestInit?.headers as Record<string, string>)["x-admin-api-key"],
    "admin-key",
  );
  assert.equal(
    (requestInit?.headers as Record<string, string>).xbypasssecret,
    "bypass-secret",
  );
});

test("per-user Fiat access rejects an unconfirmed backend value", async () => {
  const client = new FiatDepositAccessClient(config, async () =>
    Response.json({
      success: true,
      data: { user_id: "user-1", enabled: false },
    }),
  );

  await assert.rejects(
    client.update("user-1", true),
    /fiat_deposit_access_confirmation_mismatch/,
  );
});

test("per-user Fiat access fails closed without backend credentials", async () => {
  const client = new FiatDepositAccessClient({
    FIAT_ACCESS_API_BASE_URL: "https://packy.gg/v1",
  });

  await assert.rejects(
    client.update("user-1", false),
    /fiat_deposit_access_admin_key_missing/,
  );
});
