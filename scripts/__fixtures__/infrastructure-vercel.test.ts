import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("database-backed Vercel functions stay colocated with EU Railway services", () => {
  const config = JSON.parse(readFileSync("vercel.json", "utf8")) as {
    regions?: string[];
  };

  assert.deepEqual(config.regions, ["fra1"]);
});
