import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 13,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.mocha,
      },
      parserOptions: {
        ecmaVersion: 13,
        sourceType: "module",
        spread: true
      }
    },
    rules: {
      "no-unused-vars": [
        "error",
        {
          args: "none"
        }
      ],
      "no-prototype-builtins": "off"
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "*.min.js"]
  }
];
