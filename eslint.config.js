import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/main.js", "**esbuild**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node
      }
    },
    rules: {
      // Disable base rules that are covered by TypeScript equivalents
      "no-unused-vars": "off",
      "no-undef": "off", // TypeScript handles this
      "consistent-return": "off", // TypeScript handles this better

      // TypeScript-specific rules (many are already in recommended)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" }
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",

      // Keep your existing rules that work with TypeScript
      "no-prototype-builtins": "error",
      "no-template-curly-in-string": "error",
      eqeqeq: "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      curly: ["error", "all"],
      "prefer-promise-reject-errors": "error",
      "no-process-exit": "error",
      "no-path-concat": "error",
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": "error",
      "prefer-arrow-callback": "error",
      "prefer-template": "error"
    }
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node
      }
    },
    rules: {
      // Possible Errors
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-prototype-builtins": "error",
      "no-template-curly-in-string": "error",

      // Best Practices
      eqeqeq: "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "consistent-return": "error",
      curly: ["error", "all"],
      "prefer-promise-reject-errors": "error",

      // Node.js specific
      "no-process-exit": "error",
      "no-path-concat": "error",

      // Modern JavaScript
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": "error",
      "prefer-arrow-callback": "error",
      "prefer-template": "error"
    }
  },
  prettierConfig
);
