import assert from "node:assert/strict";
import test from "node:test";

import { FiatDepositAccessClient } from "../src/fiat-deposit-access.js";

const config = {
  ADMIN_API_KEY: "admin-secret",
  xbypasssecret: "rate-limit-secret",
  XBYPASSSECRET: undefined,
};

test("gets Fiat access with the admin and rate-limit bypass headers", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const client = new FiatDepositAccessClient(
    config,
    async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Response.json({
        success: true,
        data: { user_id: "user/id", enabled: true },
      });
    },
  );

  assert.deepEqual(await client.get("user/id"), {
    user_id: "user/id",
    enabled: true,
  });
  assert.equal(
    capturedUrl,
    "https://packy.gg/v1/admin/users/user%2Fid/fiat-deposit-access",
  );
  assert.equal(capturedInit?.method, "GET");
  assert.equal(
    (capturedInit?.headers as Record<string, string>)["x-admin-api-key"],
    "admin-secret",
  );
  assert.equal(
    (capturedInit?.headers as Record<string, string>).xbypasssecret,
    "rate-limit-secret",
  );
});

test("updates Fiat access with the documented PUT body", async () => {
  let capturedInit: RequestInit | undefined;
  const client = new FiatDepositAccessClient(
    config,
    async (_url, init) => {
      capturedInit = init;
      return Response.json({
        success: true,
        data: { user_id: "abc", enabled: false },
      });
    },
  );

  assert.deepEqual(await client.update("abc", false), {
    user_id: "abc",
    enabled: false,
  });
  assert.equal(capturedInit?.method, "PUT");
  assert.equal(capturedInit?.body, JSON.stringify({ enabled: false }));
  assert.equal(
    (capturedInit?.headers as Record<string, string>)["content-type"],
    "application/json",
  );
});

test("fails closed when required upstream credentials are missing", async () => {
  const client = new FiatDepositAccessClient({
    ...config,
    ADMIN_API_KEY: undefined,
  });
  await assert.rejects(
    () => client.get("abc"),
    /fiat_deposit_access_admin_key_missing/,
  );
});

test("fails closed when the response belongs to another user", async () => {
  const client = new FiatDepositAccessClient(config, async () =>
    Response.json({
      success: true,
      data: { user_id: "different-user", enabled: true },
    }),
  );

  await assert.rejects(
    () => client.update("abc", true),
    /fiat_deposit_access_invalid_response/,
  );
});

test("rejects legacy response shapes instead of guessing access state", async () => {
  for (const body of [
    true,
    { enabled: true },
    { data: { enabled: true } },
    { success: false, data: { user_id: "abc", enabled: true } },
  ]) {
    const client = new FiatDepositAccessClient(config, async () =>
      Response.json(body),
    );
    await assert.rejects(
      () => client.get("abc"),
      /fiat_deposit_access_invalid_response/,
    );
  }
});
