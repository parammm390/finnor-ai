# Minimatch compatibility package

The root toolchain has CommonJS consumers that call `require('minimatch')` directly and modern consumers that import named exports. A blanket major-version override changes the old callable API to an object and breaks ESLint and OpenAPI generation.

`finnor-minimatch-compat-11.0.1-finnor.2.tgz` contains only the callable export adapter below and a dependency on the unmodified `minimatch@11.0.1` under the alias `minimatch-modern`. All matching, preprocessing and resource limits run in that patched upstream implementation. There is no advisory suppression. Versions 10 and 11 resolve directly to 11.0.1; legacy versions 3 and 5 resolve to this adapter.

```js
'use strict'
const modern = require('minimatch-modern')
function callable(api) {
  const native = typeof api === "function" ? api : api.minimatch
  const match = (path, pattern, options) => native(path, pattern, options)
  Object.assign(match, api)
  match.defaults = options => callable(native.defaults(options))
  return match
}
module.exports = callable(modern)
```

Package metadata: `name=@finnor/minimatch-compat`, `version=11.0.1-finnor.2`, `main=index.cjs`, `license=ISC`, `dependencies={"minimatch-modern":"npm:minimatch@11.0.1"}`. Run `npm pack` on that source directory to rebuild the retained archive. The root lockfile pins its integrity.

Verification uses actual ESLint, OpenAPI generation, the root tests and build. The adapter only preserves export shape; it does not claim complete historical edge-case equivalence between major versions. Toolchain consumers are the admission checks.
