// ESLint flat config. Import rules follow DESIGN §6.3, migration rules follow API §9.1.
import { readdirSync } from "node:fs";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

// Modules from DESIGN §6.3 plus whatever already exists under src/modules.
const KNOWN_MODULES = [
  "account",
  "auth",
  "devices",
  "linking",
  "live",
  "maintenance",
  "playback",
  "security",
  "server",
  "sync",
];

function existingModules() {
  try {
    return readdirSync(new URL("./src/modules/", import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const MODULES = [...new Set([...KNOWN_MODULES, ...existingModules()])].sort();

// Modules whose ordinary files may build SQL directly (DESIGN §6.3: `sync/**`).
const SQL_MODULES = new Set(["sync"]);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const KYSELY_MESSAGE =
  "kysely is allowed only in src/db/**, *.repository.ts, src/modules/sync/** and migrations (DESIGN §6.3).";
const ENV_MESSAGE =
  "process.env is read only in src/config/env.ts, src/test/test-db.ts and scripts/ (API §10, DESIGN §6.3). Pass the parsed Env instead.";
const REPOSITORY_MESSAGE = "Do not import another module's repository; call its service instead (DESIGN §6.3).";

/**
 * Builds the restriction rules for a group of files. Flat config replaces a rule's options wholesale,
 * so every block states the complete set.
 * @param {{ kysely: boolean; env: boolean; repositories: "all" | "none" | { own: string }; migration?: boolean }} allow
 */
function restrictions(allow) {
  const paths = [];
  const patterns = [];

  if (!allow.kysely) {
    paths.push({ name: "kysely", message: KYSELY_MESSAGE });
    patterns.push({ regex: "^kysely/", caseSensitive: true, message: KYSELY_MESSAGE });
  }
  if (!allow.env) {
    paths.push(
      { name: "node:process", importNames: ["env"], message: ENV_MESSAGE },
      { name: "process", importNames: ["env"], message: ENV_MESSAGE },
    );
  }
  if (allow.repositories === "none") {
    patterns.push({ regex: "\\.repository(\\.ts)?$", caseSensitive: true, message: REPOSITORY_MESSAGE });
  } else if (typeof allow.repositories === "object") {
    const own = escapeRegex(allow.repositories.own);
    patterns.push({
      regex: `(^|/)(?!${own}\\.repository(\\.ts)?$)[^/]+\\.repository(\\.ts)?$`,
      caseSensitive: true,
      message: REPOSITORY_MESSAGE,
    });
  }

  const syntax = [];
  if (!allow.env) {
    // `process.env` and `const { env } = process` are covered by no-restricted-properties.
    syntax.push({
      selector: "MemberExpression[property.name='env'][object.type='MemberExpression'][object.property.name='process']",
      message: ENV_MESSAGE,
    });
  }
  if (allow.migration) {
    const message = "Column types in migrations come only from ddl(dialect) (API §9.1, rule 1).";
    syntax.push(
      {
        selector:
          "Literal[value=/^\\s*(text|integer|int|int2|int4|int8|smallint|bigint|real|double precision|numeric|decimal|boolean|bool|blob|bytea|json|jsonb|uuid|date|time|timestamp|timestamptz|serial|bigserial|varchar|char|character varying)(\\s*\\(.*\\))?\\s*$/i]",
        message,
      },
      {
        selector:
          "TemplateElement[value.raw=/\\b(text|integer|int|int2|int4|int8|smallint|bigint|real|numeric|decimal|boolean|bool|blob|bytea|json|jsonb|uuid|timestamp|timestamptz|serial|bigserial|varchar|collate)\\b/i]",
        message,
      },
    );
  }

  return {
    "no-restricted-imports": paths.length + patterns.length > 0 ? ["error", { paths, patterns }] : "off",
    "no-restricted-properties": allow.env
      ? "off"
      : ["error", { object: "process", property: "env", message: ENV_MESSAGE }],
    "no-restricted-syntax": syntax.length > 0 ? ["error", ...syntax] : "off",
  };
}

// Node runs the sources directly (type stripping), so relative specifiers must name the real file.
const relativeImportExtension = {
  meta: {
    type: "problem",
    docs: { description: "Require the .ts (or .json) extension in relative import specifiers." },
    messages: { missing: "Relative import '{{source}}' must end with .ts or .json: Node loads the file as written." },
    schema: [],
  },
  create(context) {
    const check = (node) => {
      const source = node.source;
      if (!source || source.type !== "Literal" || typeof source.value !== "string") return;
      const value = source.value;
      if (value !== "." && value !== ".." && !value.startsWith("./") && !value.startsWith("../")) return;
      if (/\.(ts|json)$/.test(value)) return;
      context.report({ node: source, messageId: "missing", data: { source: value } });
    };
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

const NODE_TEST_CALLS = ["describe", "suite", "it", "test", "before", "after", "beforeEach", "afterEach"];

export default defineConfig(
  {
    ignores: ["node_modules/", "coverage/", "dist/", ".data/", "openapi/", "spec/", "docs/"],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { melogold: { rules: { "relative-import-extension": relativeImportExtension } } },
    rules: {
      "melogold/relative-import-extension": "error",
      eqeqeq: ["error", "always"],
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
      "prefer-const": "error",
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true, requireDefaultForNonUnion: true },
      ],
      "@typescript-eslint/no-floating-promises": [
        "error",
        { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: NODE_TEST_CALLS }] },
      ],
    },
  },

  // Import and process.env restrictions (DESIGN §6.3). Later blocks override earlier ones.
  { files: ["src/**/*.ts"], rules: restrictions({ kysely: false, env: false, repositories: "none" }) },
  { files: ["src/**/*.repository.ts"], rules: restrictions({ kysely: true, env: false, repositories: "none" }) },
  ...MODULES.flatMap((name) => [
    {
      files: [`src/modules/${name}/**/*.ts`],
      rules: restrictions({ kysely: SQL_MODULES.has(name), env: false, repositories: { own: name } }),
    },
    {
      files: [`src/modules/${name}/**/*.repository.ts`],
      rules: restrictions({ kysely: true, env: false, repositories: { own: name } }),
    },
  ]),
  { files: ["src/db/**/*.ts"], rules: restrictions({ kysely: true, env: false, repositories: "none" }) },
  {
    files: ["src/db/migrations/**/*.ts"],
    rules: restrictions({ kysely: true, env: false, repositories: "none", migration: true }),
  },
  { files: ["src/config/env.ts"], rules: restrictions({ kysely: false, env: true, repositories: "none" }) },
  {
    files: ["src/test/**/*.ts", "src/**/*.test.ts"],
    rules: {
      ...restrictions({ kysely: true, env: false, repositories: "all" }),
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  { files: ["src/test/test-db.ts"], rules: restrictions({ kysely: true, env: true, repositories: "all" }) },
  { files: ["scripts/**/*.ts"], rules: restrictions({ kysely: true, env: true, repositories: "all" }) },
);
