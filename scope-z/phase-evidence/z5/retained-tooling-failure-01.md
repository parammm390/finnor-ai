# Retained read-only tooling bootstrap failures

Workspace/client/forms check 01 exited 0. Manifest, coverage and lint check 01
each actually exited 1; all original logs remain unchanged.

- The canonical metadata child deliberately strips environment configuration
  and could not find `tsx/cjs/api` without an installation.
- The original engineering bridge did not resolve CommonJS TypeScript from
  the separately installed backend tooling pool.
- The linter's Babel resolver could not resolve `next/babel` from this
  uninstalled source checkout. These parsing errors are not a completed lint.

The bridge now declares both third-party pools, resolves CommonJS tooling
explicitly, and propagates only that bridge to the exact credential-free
metadata child. Its original network/action denials stay in place. No
relative, project-alias or @finnor peer-source fallback is added. Metadata
goes to stderr so the canonical child's JSON result remains unmodified.

The reruns remain read-only engineering checks with borrowed third-party
tooling, not a fresh Z5 install, native runtime or protected qualification.

Checks 02 still failed because `require.resolve` / the TS loader's legacy
resolver bypass synchronous Node module hooks. An explicitly bounded legacy
third-party-only resolver fixed that bootstrap; manifest and full lint 03
passed. Lint retains 18 warnings, including one in the proposed Z5 panel and
a duplicate actual/virtual World warning, not 18 new Z5 findings.

Coverage 03 then reached the actual auditor and found five unresolved
baseline route expressions. Its TypeScript program lacked React/other
declarations because this checkout is uninstalled. The separate coverage
declaration bridge supplies the same explicit third-party declarations as the
whole graph checker. It does not change the auditor source, filter unresolved
calls, change expected output or weaken any failure predicate. The rerun and
its graph/declaration identities remain separate from this original failure.
