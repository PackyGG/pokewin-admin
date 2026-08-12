import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const required = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"];
if (required.some((name) => !process.env[name])) {
  console.log("Sentry source-map upload skipped: build credentials are not configured.");
  process.exit(0);
}

const cli = fileURLToPath(new URL("../node_modules/@sentry/cli/bin/sentry-cli", import.meta.url));
const release = process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.SENTRY_RELEASE;
const common = ["sourcemaps", "--org", process.env.SENTRY_ORG, "--project", process.env.SENTRY_PROJECT];

function run(args) {
  const result = spawnSync(cli, args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run([...common, "inject", "dist/src"]);
run([
  ...common,
  "upload",
  ...(release ? ["--release", release] : []),
  "--validate",
  "--wait",
  "dist/src",
]);
