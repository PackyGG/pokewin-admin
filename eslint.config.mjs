import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  // Respect the `_`-prefix convention for intentionally-unused symbols
  // (e.g. `void _period`, `_policy`, `_scenario`, `_senderUserId`).
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".claude/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  // Playwright E2E tests use `use()` to yield fixtures. The Next/React
  // eslint preset mistakes that for React's `use()` hook and fires
  // react-hooks/rules-of-hooks. Scope both rules off inside e2e/.
  {
    files: ["e2e/**/*.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  },
  // Database boundary: the ClickHouse read layer must never import a Postgres /
  // Prisma client. Reads go to ClickHouse, writes stay on Postgres (getDb /
  // adminDb) — these two worlds never cross inside src/lib/clickhouse/**.
  {
    files: ["src/lib/clickhouse/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/lib/db", message: "ClickHouse read layer must not import the Postgres game client." },
            { name: "@/lib/admin-db", message: "ClickHouse read layer must not import the Postgres admin client." },
            { name: "pg", message: "ClickHouse read layer must not import the Postgres driver." },
          ],
          patterns: [
            {
              group: ["@/generated/prisma*", "@/generated/admin-prisma*", "@prisma/*"],
              message: "ClickHouse read layer must not import Prisma.",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
