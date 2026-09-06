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
  ...truthRuleOverrides,
]
