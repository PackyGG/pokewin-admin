import assert from "node:assert/strict";
import test from "node:test";

import { FiatDepositAccessClient } from "../src/fiat-deposit-access.js";

const config = {
  API_URL: "https://api.example.test",
  BACKEND_API_URL: undefined,
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
      return Response.json({ data: { enabled: true } });
    },
  );

  assert.deepEqual(await client.get("user/id"), { enabled: true });
  assert.equal(
    capturedUrl,
    "https://api.example.test/v1/admin/users/user%2Fid/fiat-deposit-access",
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
    { ...config, API_URL: "https://api.example.test/v1/" },
    async (_url, init) => {
      capturedInit = init;
      return Response.json({ enabled: false });
    },
  );

  assert.deepEqual(await client.update("abc", false), { enabled: false });
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
