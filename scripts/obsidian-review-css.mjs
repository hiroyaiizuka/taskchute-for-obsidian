// The CSS half of the Obsidian plugin review — an *approximation*.
//
// Obsidian's dashboard reports CSS findings that no published package
// implements: `eslint-plugin-obsidianmd` (0.4.2) carries no CSS rules at all
// and does not depend on `@eslint/css`. The bot's own CSS analyser is not open
// source, so everything below is reconstructed from the findings it returned
// for this plugin, quoting its wording verbatim so a local report reads like
// the dashboard's. Treat a clean run here as "no known regression", never as
// "the dashboard will pass".
//
// What the dashboard reported for taskchute-plus 2.2.x, and where it lives now:
//
//   Avoid !important ...                        -> css/no-important (official
//                                                  @eslint/css rule, kept as-is
//                                                  even though its wording
//                                                  differs from the bot's)
//   Avoid :has ...                              -> no-has, below
//   Unexpected browser feature "text-decoration" -> partially-supported-feature,
//     is only partially supported by Obsidian      below
//
// Deliberately NOT enabled: `css/use-baseline`. It looks like the right rule
// for the "browser feature" finding, but it answers a different question --
// Baseline is "supported across Chrome, Edge, Firefox and Safari", while
// Obsidian ships a single Chromium. Run against this stylesheet it reports 31
// findings (user-select, resize, overscroll-behavior, ...) that the dashboard
// does not, because Obsidian's Chromium supports them. A gate that cries wolf
// 31 times is a gate people learn to ignore.

// The bot names a fixed Obsidian version in its message rather than the
// plugin's own minAppVersion (this plugin declares 1.13.0 and was told about
// 1.11.4). It is a constant on their side, so it is a constant here too, and it
// goes stale the same way theirs does.
const OBSIDIAN_BASELINE = "1.11.4";

// Shorthands the dashboard rejects unless they carry a single keyword. This is
// the whole of what it flagged; it is a list of observations, not a model of
// their analyser, so only add a property here after the dashboard names it.
const SINGLE_KEYWORD_SHORTHANDS = new Set(["text-decoration"]);

function valueChildren(value) {
  if (!value) return [];
  // css-tree hands back a List; @eslint/css exposes it untouched.
  if (Array.isArray(value.children)) return value.children;
  if (typeof value.children?.toArray === "function") return value.children.toArray();
  return [];
}

const noHas = {
  meta: {
    type: "problem",
    docs: { description: "Avoid the :has() selector, as Obsidian's plugin review rejects it." },
    schema: [],
    messages: {
      avoidHas:
        "Avoid :has — it can cause significant performance issues due to broad selector invalidation.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      PseudoClassSelector(node) {
        if (node.name !== "has") return;
        context.report({ loc: sourceCode.getLoc(node), messageId: "avoidHas" });
      },
    };
  },
};

const partiallySupportedFeature = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Avoid shorthand forms Obsidian's bundled Chromium only partially supports.",
    },
    schema: [],
    messages: {
      partiallySupported:
        'Unexpected browser feature "{{feature}}" is only partially supported by Obsidian {{version}}',
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      Declaration(node) {
        if (!SINGLE_KEYWORD_SHORTHANDS.has(node.property)) return;
        // One keyword is accepted (`text-decoration: none`); the multi-value
        // form is what gets flagged, and the longhands are the way out.
        if (valueChildren(node.value).length < 2) return;
        context.report({
          loc: sourceCode.getLoc(node),
          messageId: "partiallySupported",
          data: { feature: node.property, version: OBSIDIAN_BASELINE },
        });
      },
    };
  },
};

export default {
  meta: { name: "obsidian-review-approx" },
  rules: {
    "no-has": noHas,
    "partially-supported-feature": partiallySupportedFeature,
  },
};

export { OBSIDIAN_BASELINE };
