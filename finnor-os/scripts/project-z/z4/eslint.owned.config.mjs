import rootConfig from "../../../../eslint.config.mjs";

// The root deliberately ignores finnor-os. Apply its actual parser/rules to
// the explicit owned file list instead of reporting ignored files as linted.
export default rootConfig.filter((entry) => !entry.ignores || entry.files);
