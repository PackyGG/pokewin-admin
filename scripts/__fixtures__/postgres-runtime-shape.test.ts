import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RAW_QUERY_CALLEES = new Set(["execute", "queryRows", "queryMainRows"]);
const TIMESTAMP_FIELD =
  /(?:^|_)(?:at|date|time|timestamp|start|end|after|before)$|(?:At|Date|Time|Timestamp|Start|End|After|Before)$|^(?:date|bucket)$/;

type Violation = {
  file: string;
  line: number;
  field: string;
  callee: string;
};

function trackedSourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "src/**/*.ts", "src/**/*.tsx"], {
    cwd: root,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter((file) => file && existsSync(path.join(root, file)));
}

function calleeName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function includesRuntimeString(type: ts.TypeNode): boolean {
  if (type.kind === ts.SyntaxKind.StringKeyword || type.kind === ts.SyntaxKind.UnknownKeyword) {
    return true;
  }
  return ts.isUnionTypeNode(type) && type.types.some(includesRuntimeString);
}

function includesDate(type: ts.TypeNode): boolean {
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    return type.typeName.text === "Date";
  }
  return ts.isUnionTypeNode(type) && type.types.some(includesDate);
}

function propertyName(member: ts.PropertySignature): string | null {
  if (member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
    return member.name.text;
  }
  return null;
}

function collectProperties(
  node: ts.TypeNode,
  output: ts.PropertySignature[],
  declarations: Map<string, ts.TypeAliasDeclaration | ts.InterfaceDeclaration>,
  visited = new Set<string>(),
) {
  if (ts.isTypeLiteralNode(node)) {
    output.push(...node.members.filter(ts.isPropertySignature));
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;
    if (!visited.has(name)) {
      const declaration = declarations.get(name);
      if (declaration) {
        visited.add(name);
        if (ts.isTypeAliasDeclaration(declaration)) {
          collectProperties(declaration.type, output, declarations, visited);
        } else {
          output.push(...declaration.members.filter(ts.isPropertySignature));
        }
      }
    }
  }
  node.forEachChild((child) => {
    if (ts.isTypeNode(child)) {
      collectProperties(child, output, declarations, visited);
    }
  });
}

function violationsFor(file: string): Violation[] {
  const sourceText = readFileSync(path.join(root, file), "utf8");
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];
  const declarations = new Map<
    string,
    ts.TypeAliasDeclaration | ts.InterfaceDeclaration
  >();

  source.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      declarations.set(node.name.text, node);
    }
  });

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node);
      if (callee && RAW_QUERY_CALLEES.has(callee)) {
        for (const typeArgument of node.typeArguments ?? []) {
          const properties: ts.PropertySignature[] = [];
          collectProperties(typeArgument, properties, declarations);
          for (const member of properties) {
              if (!member.type) continue;
              const field = propertyName(member);
              if (
                !field ||
                !TIMESTAMP_FIELD.test(field) ||
                !includesDate(member.type) ||
                includesRuntimeString(member.type)
              ) {
                continue;
              }
              const { line } = source.getLineAndCharacterOfPosition(member.getStart(source));
              violations.push({ file, line: line + 1, field, callee });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return violations;
}

test("raw PostgreSQL timestamp result types include their runtime string shape", () => {
  const violations = trackedSourceFiles().flatMap(violationsFor);
  const signatures = Object.entries(
    violations.reduce<Record<string, number>>((counts, violation) => {
      const key = `${violation.file}|${violation.callee}|${violation.field}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
  ).sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(
    signatures,
    [],
    [
      "Raw Drizzle/pg result types cannot promise Date-only timestamp fields.",
      "Production drivers may return timestamp values as strings.",
      "Type the field as Date | string and normalize it before Date methods.",
    ].join(" "),
  );
});
