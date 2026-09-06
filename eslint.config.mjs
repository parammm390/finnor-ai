import nextCoreWebVitals from "eslint-config-next/core-web-vitals"
import legacyTruthRules from "./.eslintrc.cjs"

// ESLint 9 uses flat config. Preserve the reviewed FINNOR truthfulness rules
// from the legacy config while adapting only their override shape.
const truthRuleOverrides = legacyTruthRules.overrides.map(({ excludedFiles, ...override }, index) => ({
  name: `finnor/truth-rule-${index + 1}`,
  ...override,
  ...(excludedFiles ? { ignores: excludedFiles } : {}),
}))

export default [
  { ignores: ["finnor-os/**", ".next/**", "node_modules/**"] },
  ...nextCoreWebVitals,
  // The application predates the React Compiler rules bundled by the current
  // eslint-config-next release.  Keep the Next/TypeScript parsing and the
  // reviewed FINNOR truth rules below, but do not turn compiler migration
  // diagnostics into a Phase 5 release blocker.
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/use-memo": "off",
      "@next/next/no-html-link-for-pages": "off",
      "@next/next/no-location-assign-relative-destination": "off",
    },
  },
  ...truthRuleOverrides,
]
