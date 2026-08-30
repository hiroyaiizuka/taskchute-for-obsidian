// The reconstructed CSS half of the Obsidian plugin review.
//
// Separate from eslint.review.config.mjs for two reasons. The honest one: the
// rules here are ours, rebuilt from the findings the dashboard returned, and
// nothing about them should be mistaken for the config Obsidian publishes. The
// mechanical one: eslint-plugin-obsidianmd's recommended config layers
// js.configs.recommended over every file, and those rules throw on a CSS tree
// (`sourceCode.getAllComments is not a function`), so the two cannot share a
// config array.
//
// scripts/obsidian-review.mjs runs both and merges the reports.
import css from "@eslint/css";
import obsidianReviewApprox from "./scripts/obsidian-review-css.mjs";

export default [
  {
    ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**", "tmp/**"],
  },
  {
    files: ["**/*.css"],
    plugins: { css, "obsidian-review-approx": obsidianReviewApprox },
    language: "css/css",
    rules: {
      // @eslint/css's own rule. Its wording differs from the dashboard's
      // ("Unexpected !important flag found." vs "Avoid !important — override
      // styles by increasing selector specificity or using CSS variables
      // instead."), and it stays as published rather than being reworded.
      "css/no-important": "error",
      "obsidian-review-approx/no-has": "error",
      "obsidian-review-approx/partially-supported-feature": "error",
    },
  },
];
