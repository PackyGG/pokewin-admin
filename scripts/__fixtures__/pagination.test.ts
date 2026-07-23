import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePage, parsePerPage, parsePagination, MAX_PER_PAGE } from "../../src/lib/utils/pagination.ts";

test("page: hostile + junk input all collapse to 1", () => {
  for (const v of [undefined, "", "  ", "abc", "0", "-5", "-1e9", "1.5", "NaN", "Infinity", "-Infinity", "null"]) {
    assert.equal(parsePage(v), 1, `page(${String(v)})`);
  }
});
test("page: valid passes, huge is capped", () => {
  assert.equal(parsePage("1"), 1);
  assert.equal(parsePage("42"), 42);
  assert.equal(parsePage("1e9"), 100_000);
  assert.equal(parsePage("999999999999"), 100_000);
});
test("perPage: never exceeds the ceiling, never below 1", () => {
  assert.equal(parsePerPage("1000000"), MAX_PER_PAGE);
  assert.equal(parsePerPage("1e9"), MAX_PER_PAGE);
  assert.equal(parsePerPage("-5"), 20);
  assert.equal(parsePerPage("0"), 20);
  assert.equal(parsePerPage("1.5"), 20);
  assert.equal(parsePerPage(undefined), 20);
  assert.equal(parsePerPage("50"), 50);
});
test("perPage: a bad default cannot smuggle a huge page size", () => {
  assert.equal(parsePerPage(undefined, 999999), MAX_PER_PAGE);
  assert.equal(parsePerPage(undefined, -3), 1);
  assert.equal(parsePerPage(undefined, 40), 40);
});
test("skip/take stay non-negative integers for every input", () => {
  for (const p of [undefined, "-5", "0", "abc", "1e12", "3"]) {
    for (const pp of [undefined, "-1", "0", "1e9", "25"]) {
      const { page, perPage } = parsePagination({ page: p, perPage: pp });
      const skip = (page - 1) * perPage;
      assert.ok(Number.isInteger(skip) && skip >= 0, `skip ${skip}`);
      assert.ok(Number.isInteger(perPage) && perPage >= 1 && perPage <= MAX_PER_PAGE, `take ${perPage}`);
    }
  }
});
