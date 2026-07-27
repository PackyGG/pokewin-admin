import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const repoRoot = process.cwd();
const readResolvers = new Set([
  "getReadDrizzleDb",
  "getProdReadDrizzleDb",
  "getDevReadDrizzleDb",
  "readDrizzleForEnv",
]);

function trackedRuntimeFiles(): string[] {
  return execFileSync("git", ["ls-files", "src/**/*.ts", "src/**/*.tsx"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

test("mirror DB configuration fails closed and forces read-only sessions", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/lib/db.ts"), "utf8");
  assert.match(source, /MIRROR_PRODUCTION_DB/);
  assert.match(source, /MIRROR_DEV_DB/);
  assert.match(source, /default_transaction_read_only=on/);
  assert.match(source, /getReadDrizzleDb/);
  assert.match(source, /getPrimaryDrizzleDb/);
  assert.doesNotMatch(source, /MIRROR_PRODUCTION_DB\s*\?\?\s*process\.env\.DATABASE_URL/);
  assert.doesNotMatch(source, /MIRROR_DEV_DB\s*\?\?\s*process\.env\.DEV_DATABASE_URL/);
});

test("query modules cannot request the writable MAIN client", () => {
  const files = execFileSync("git", ["ls-files", "src/lib/queries/**/*.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);

  for (const file of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.doesNotMatch(source, /getPrimaryDrizzleDb|primaryDrizzleForEnv/, file);
  }
});

test("read clients are not used for direct MAIN mutations", () => {
  const violations: string[] = [];

  for (const file of trackedRuntimeFiles()) {
    const absolutePath = path.join(repoRoot, file);
    const sourceText = fs.readFileSync(absolutePath, "utf8");
    if (![...readResolvers].some((name) => sourceText.includes(name))) continue;

    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const readBindings = new Set<string>();

    function collect(node: ts.Node): void {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        readResolvers.has(node.initializer.expression.text)
      ) {
        readBindings.add(node.name.text);
      }
      ts.forEachChild(node, collect);
    }

    function inspect(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        readBindings.has(node.expression.expression.text)
      ) {
        const method = node.expression.name.text;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (method === "insert" || method === "update" || method === "delete") {
          violations.push(`${file}:${line} uses ${node.expression.expression.text}.${method}`);
        }
        if (
          method === "execute" &&
          node.arguments.some((argument) =>
            /\b(insert|update|delete|alter|create|drop|truncate)\b/i.test(
              argument.getText(sourceFile),
            ),
          )
        ) {
          violations.push(`${file}:${line} executes a mutation through a read client`);
        }
      }
      ts.forEachChild(node, inspect);
    }

    collect(sourceFile);
    inspect(sourceFile);
  }

  assert.deepEqual(violations, []);
});
