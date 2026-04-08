import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "eslint.config.mjs"],
  },
  js.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      "import/core-modules": ["bun:test", "bun:jsc", "node:fs", "node:path", "node:os", "or3-net"],
      "import/resolver": {
        typescript: true,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false } },
      ],
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-enum-comparison": "error",
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unnecessary-type-parameters": "error",
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: false }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/require-await": "error",
      "import/first": "error",
      "import/newline-after-import": "error",
      "import/no-default-export": "error",
      "import/no-duplicates": "error",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    rules: {
      "import/no-default-export": "off",
    },
  },
  {
    files: ["src/host-control/service.ts"],
    rules: {
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
);
