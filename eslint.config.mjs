import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import globals from "globals";

const unused = { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true };

export default defineConfig(
  { ignores: ["**/node_modules/**", ".tools/**", ".media/**", "dist/**", "dist-server/**", "data/**", "coverage/**", "public/**", ".claude/**"] },
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: { "no-unused-vars": ["error", unused], "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { "@typescript-eslint/no-unused-vars": ["error", unused], "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/no-empty-function": "off" },
  },
);
