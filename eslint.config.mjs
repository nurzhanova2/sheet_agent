import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "artifacts/**",
      "**/bin/**",
      "**/obj/**",
      // Stage 27 §8 — the vendored Pyodide runtime. Third-party, minified, and
      // reproduced by a script rather than edited; linting it says nothing
      // about this repository and buries real findings under 5 000 of its own.
      "apps/addin/public/pyodide/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error"
    }
  }
);
