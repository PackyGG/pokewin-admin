import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".vercel",
  "node_modules",
]);

type RepositoryFilesOptions = {
  root: string;
  pathspecs?: string[];
  includeUntracked?: boolean;
};

function pathspecExpression(pathspec: string): RegExp {
  let expression = "^";

  for (let index = 0; index < pathspec.length; index += 1) {
    const character = pathspec[index];
    if (character === "*" && pathspec[index + 1] === "*") {
      index += 1;
      if (pathspec[index + 1] === "/") {
        index += 1;
        expression += "(?:[^/]+/)+";
      } else {
        expression += ".*";
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }

  return new RegExp(`${expression}$`);
}

function filesystemFiles(root: string): string[] {
  const files: string[] = [];

  function walk(relativeDirectory: string): void {
    const absoluteDirectory = path.join(root, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) walk(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  walk("");
  return files.sort();
}

export function repositoryFiles({
  root,
  pathspecs = [],
  includeUntracked = false,
}: RepositoryFilesOptions): string[] {
  if (existsSync(path.join(root, ".git"))) {
    const args = ["ls-files"];
    if (includeUntracked) {
      args.push("--cached", "--others", "--exclude-standard");
    }
    args.push(...pathspecs);
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .filter((file) => file && existsSync(path.join(root, file)));
  }

  const expressions = pathspecs.map(pathspecExpression);
  return filesystemFiles(root).filter(
    (file) => expressions.length === 0 || expressions.some((pattern) => pattern.test(file)),
  );
}
