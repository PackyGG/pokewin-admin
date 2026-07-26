import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

function isHistoricalArtifact(file: string): boolean {
  return (
    /(?:^|\/)(?:archive|archives)(?:\/|$)/i.test(file) ||
    /(?:^|\/)[^/]*archive[^/]*\.(?:md|json|sql)$/i.test(file) ||
    /(?:^|\/)migrations?\/.*\.sql$/i.test(file) ||
    file === "src/lib/changelog/recent-pushes.json" ||
    file === "scripts/__fixtures__/postgres-drizzle-boundary.test.ts"
  );
}

function runtimeAndConfigFiles(): string[] {
  return trackedFiles().filter((file) => {
    if (isHistoricalArtifact(file)) return false;
    if (/^(?:src|scripts|e2e)\//.test(file)) {
      return /\.(?:ts|tsx|js|jsx|mjs|cjs|json)$/.test(file);
    }
    return (
      /^(?:package(?:-lock)?\.json|vercel\.json|\.env\.example)$/.test(file) ||
      /(?:^|\/)(?:next|eslint|drizzle(?:\.[^.]+)?|prisma(?:\.[^.]+)?)\.config\.(?:ts|js|mjs|cjs)$/.test(
        file,
      )
    );
  });
}

function filesContaining(
  pattern: string,
  files: string[],
  { ignoreCase = false }: { ignoreCase?: boolean } = {},
): string[] {
  if (files.length === 0) return [];
  const allowed = new Set(files);
  try {
    const args = ["grep", "-Il", "-E"];
    if (ignoreCase) args.push("-i");
    args.push(pattern);
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .filter((file) => allowed.has(file));
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return [];
    throw error;
  }
}

test("tracked runtime and config contain no retired ClickHouse backend", () => {
  const retiredBackend = [
    "@clickhouse/client",
    "(^|[^[:alnum:]_])clickhouse([^[:alnum:]_]|$)",
    "CLICKHOUSE_[A-Z0-9_]+",
    "clickhouses?://",
  ].join("|");
  assert.deepEqual(
    filesContaining(retiredBackend, runtimeAndConfigFiles(), {
      ignoreCase: true,
    }),
    [],
  );
});

test("tracked runtime and config contain no Prisma client dependency", () => {
  const prismaClientDependency = [
    "@prisma/(client|adapter-[a-z0-9_-]+)",
    "generated/(admin-)?prisma(/|[^[:alnum:]_]|$)",
    "(^|[^[:alnum:]_])PrismaClient([^[:alnum:]_]|$)",
    "(^|[^[:alnum:]_])PrismaPg([^[:alnum:]_]|$)",
  ].join("|");
  const files = runtimeAndConfigFiles().filter(
    (file) => file !== "package-lock.json",
  );
  assert.deepEqual(
    filesContaining(prismaClientDependency, files),
    [],
  );

  // Drizzle advertises optional compatibility peers in its own lockfile
  // metadata. Only the root package set represents dependencies this app
  // actually installs.
  const lock = JSON.parse(
    readFileSync(path.join(root, "package-lock.json"), "utf8"),
  ) as {
    packages?: {
      ""?: {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
    };
  };
  const rootDependencies = {
    ...lock.packages?.[""]?.dependencies,
    ...lock.packages?.[""]?.devDependencies,
  };
  assert.deepEqual(
    Object.keys(rootDependencies).filter(
      (name) => name === "prisma" || name.startsWith("@prisma/"),
    ),
    [],
  );
});
