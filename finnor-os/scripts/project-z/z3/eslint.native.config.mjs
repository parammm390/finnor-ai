// Same reviewed root rules; remove only the monorepo-wide backend exclusion.
// Commands pass the exact owned Z3 leaves, never the whole backend.
import base from "../../../../eslint.config.mjs";
export default base.map((config, index) => index === 0
  ? { ...config, ignores: config.ignores.filter(pattern => pattern !== "finnor-os/**") } : config);
