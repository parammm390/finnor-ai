/** Owns only this disposable controller and its assigned-pane UI proof driver. */
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
if (process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING) throw Error('AMBIENT_DATABASE_REFUSED');
const runner = spawn(process.execPath, ['--import=tsx', join(root, 'finnor-os/scripts/p3/run-e2e.mts'), '--browser'],
  { cwd: join(root, 'finnor-os'), stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
let pending = '', driver;
runner.stdout.on('data', bytes => {
  process.stdout.write(bytes);
  pending += bytes.toString();
  const lines = pending.split('\n'); pending = lines.pop();
  for (const line of lines) {
    let ready; try { ready = JSON.parse(line); } catch { continue; }
    if (!ready.browserReady || driver) continue;
    driver = spawn(process.execPath, [join(root, 'finnor-os/scripts/p3/browser-e2e.mjs'), ready.browserReady],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    driver.stdout.on('data', bytes => process.stdout.write(bytes));
    driver.stderr.on('data', bytes => process.stderr.write(bytes));
  }
});
runner.stderr.on('data', bytes => process.stderr.write(bytes));
const exit = await new Promise((yes, no) => {
  runner.once('error', no); runner.once('exit', (code, signal) => yes({ code, signal }));
});
if (driver?.exitCode === null) await new Promise(resolve => driver.once('exit', resolve));
process.exitCode = exit.code === 0 && !exit.signal && driver?.exitCode === 0 ? 0 : 1;
