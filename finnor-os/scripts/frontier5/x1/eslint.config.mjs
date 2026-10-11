import parser from "@typescript-eslint/parser";

export default [{
  files: ["finnor-os/packages/private-equity/src/institution-program/**/*.ts", "finnor-os/scripts/frontier5/x1/**/*.mts"],
  languageOptions: { parser, parserOptions: { ecmaVersion: "latest", sourceType: "module" } },
  rules: { "no-debugger": "error", "no-constant-condition": "error", "no-duplicate-imports": "error" },
}];
