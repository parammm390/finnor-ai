import assert from 'node:assert/strict';

/** Accept only the observed Next type-directory rewrite, never other edits. */
export function assertKnownNextTypeInput(path, original, current, distDir = '.next-x1-install') {
  assert.ok(['.next-x1-install', '.next-w2-install'].includes(distDir), 'X1_KNOWN_FRONTEND_TYPE_DIRECTORY_REQUIRED');
  if (path === 'tsconfig.json') {
    const old = JSON.parse(original), next = JSON.parse(current);
    const additions = [`${distDir}/types/**/*.ts`, `${distDir}/dev/types/**/*.ts`];
    assert.deepEqual(next.include.filter(p => !additions.includes(p)), old.include,
      'X1_FRONTEND_TSCONFIG_GENERATED_INPUT_REFUSED');
    assert.ok(additions.every(p => next.include.filter(v => v === p).length === 1),
      'X1_FRONTEND_TSCONFIG_GENERATED_INPUT_REFUSED');
    next.include = old.include;
    assert.deepEqual(next, old, 'X1_FRONTEND_TSCONFIG_GENERATED_INPUT_REFUSED');
  } else if (path === 'next-env.d.ts') {
    const expected = original.toString().replace(
      /^import (["'])\.\/\.next\/(?:dev\/)?types\/(routes|root-params)\.d\.ts\1(;?)$/gm,
      (_, quote, name, ending) => `import ${quote}./${distDir}/types/${name}.d.ts${quote}${ending}`);
    assert.equal(current.toString(), expected, 'X1_FRONTEND_NEXT_ENV_GENERATED_INPUT_REFUSED');
  } else throw Error('X1_FRONTEND_ORIGINAL_SOURCE_CHANGED:' + path);
}
