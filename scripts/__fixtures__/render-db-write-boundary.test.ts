import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WRITE_HELPER =
  /^(?:ensure|upsert|create|insert|update|delete|touch|record|sync|backfill|migrate|refresh)[A-Z]/;
const DIRECT_WRITE_METHODS = new Set([
  "insert",
  "update",
  "delete",
  "transaction",
]);
const RAW_WRITE = /\b(?:insert|update|delete|merge|create|alter|drop|truncate)\b/i;

type Violation = {
  file: string;
  line: number;
  call: string;
};

function trackedRenderModules(): string[] {
  return execFileSync(
    "git",
    ["ls-files", "src/app/**/page.tsx", "src/app/**/layout.tsx"],
    { cwd: root, encoding: "utf8" },
  )
    .split(/\r?\n/)
    .filter(Boolean);
}

function isInsideAfterCallback(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current?.parent) {
    const parent = current.parent;
    if (
      (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
      ts.isCallExpression(parent.parent) &&
      ts.isIdentifier(parent.parent.expression) &&
      parent.parent.expression.text === "after" &&
      parent.parent.arguments[0] === parent
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

function rawSqlText(call: ts.CallExpression): string {
  const first = call.arguments[0];
  if (!first || !ts.isTaggedTemplateExpression(first)) return "";
  if (!ts.isIdentifier(first.tag) || first.tag.text !== "sql") return "";
  return first.template.getText();
}

function violationsFor(file: string): Violation[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(path.join(root, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: Violation[] = [];

  function add(node: ts.Node, call: string) {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push({ file, line: line + 1, call });
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && !isInsideAfterCallback(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        WRITE_HELPER.test(node.expression.text)
      ) {
        add(node, node.expression.text);
      }

      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression.getText(source);
        if (
          DIRECT_WRITE_METHODS.has(method) &&
          /(?:adminDrizzle|\btx)$/.test(receiver)
        ) {
          add(node, `${receiver}.${method}`);
        }
        if (
          method === "execute" &&
          /(?:adminDrizzle|\btx)$/.test(receiver) &&
          RAW_WRITE.test(rawSqlText(node))
        ) {
          add(node, `${receiver}.execute(DML)`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return violations;
}

test("page and layout renders never mutate the ADMIN database", () => {
  const violations = trackedRenderModules().flatMap(violationsFor);
  assert.deepEqual(
    violations,
    [],
    "Move writes to authenticated Server Actions or next/server after() callbacks.",
  );

  assert.equal(
    existsSync(path.join(root, "src/lib/support-baseline.ts")),
    false,
    "support page-load self-heal must stay deleted",
  );
  assert.equal(
    existsSync(path.join(root, "src/lib/pack-creator/ensure-capabilities.ts")),
    false,
    "pack creator page-load self-heal must stay deleted",
  );
});
