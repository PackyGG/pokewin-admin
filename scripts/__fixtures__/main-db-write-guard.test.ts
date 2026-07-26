import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mainDbWritesAllowed } from "../../e2e/helpers/db";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalOverride = process.env.E2E_ALLOW_MAIN_DB_WRITES;

after(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalOverride === undefined) {
    delete process.env.E2E_ALLOW_MAIN_DB_WRITES;
  } else {
    process.env.E2E_ALLOW_MAIN_DB_WRITES = originalOverride;
  }
});

test("E2E MAIN writes stay disabled for remote databases", () => {
  process.env.DATABASE_URL = "postgresql://test:test@db.example.test/main";
  process.env.E2E_ALLOW_MAIN_DB_WRITES = "1";
  assert.equal(mainDbWritesAllowed(), false);
});

test("E2E MAIN writes are allowed only for local scratch databases", () => {
  delete process.env.E2E_ALLOW_MAIN_DB_WRITES;
  for (const host of ["localhost", "127.0.0.1", "host.docker.internal"]) {
    process.env.DATABASE_URL = `postgresql://test:test@${host}/scratch`;
    assert.equal(mainDbWritesAllowed(), true);
  }
});
