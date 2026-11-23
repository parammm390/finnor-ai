import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = resolve(root, 'scope-postz/w2-accountable-workforce/evidence');
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || !output.startsWith(`${evidence}${sep}`)) {
  throw new Error('Supply an absolute new output path inside the W2 evidence directory.');
}

function git(...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  }).trimEnd();
}

function selected(path) {
  if (/(^|\/)(node_modules|\.next|dist|coverage)(\/|$)/.test(path)) return false;
  if (/^scope-postz\/w2-accountable-workforce\/(evidence|handoff)\//.test(path)) return false;
  if (/(^|\/)\.env($|\.)/.test(path) && !/\.example$/.test(path)) return false;
  if (/\.(pem|key|p12|pfx)$/.test(path)) return false;
  return /^(finnor-os|src|public|infra|\.github|e2e|scripts|docs|scope-postz\/w2-accountable-workforce)\//.test(path)
    || (!path.includes('/') && /(\.(json|[cm]?js|[cm]?ts|md)|-lock\.yaml)$/.test(path));
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

const paths = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
  .split('\0').filter(Boolean).filter(selected))].sort();
const sources = [];
for (const path of paths) {
  const absolute = resolve(root, path);
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error(`Selected source is not a file: ${path}`);
  sources.push({ path, bytes: metadata.size, sha256: await digest(absolute) });
}
const manifest = {
  schema: 'finnor.postz.w2.source-manifest.v1',
  capturedAt: new Date().toISOString(),
  root,
  commit: git('rev-parse', 'HEAD'),
  tree: git('rev-parse', 'HEAD^{tree}'),
  branch: git('branch', '--show-current'),
  stagedPaths: git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean),
  unstagedPaths: git('diff', '--name-only', '-z').split('\0').filter(Boolean),
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  selectedSourceDigest: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
  sources,
  claims: { sourceIdentityOnly: true, installedVerification: false, admission: false },
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  output: relative(root, output),
  commit: manifest.commit,
  selectedSourceDigest: manifest.selectedSourceDigest,
  files: sources.length,
  bytes: sources.reduce((sum, source) => sum + source.bytes, 0),
})}\n`);
