/** Credential-free, quiescent tmpfs checkpoint target, not an owner grant. */
import { openSync, writeFileSync, readFileSync, fsyncSync, closeSync, readSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const state = { schema: 'finnor.p3.raw-checkpoint-state.v1', counter: 7, value: 'C_01:2000:C_010:20000' };
writeFileSync('/state/state.json', JSON.stringify(state), { mode: 0o600 });
const file = openSync('/state/state.json', 'r'); fsyncSync(file); closeSync(file);
writeFileSync('/state/identity.json', JSON.stringify({ identity: randomUUID(), container: process.env.FINNOR_P3_RESTORE_ID ?? null }));
const checkpoint = openSync('/proc/gvisor/checkpoint', 'r');
process.stdout.write('{"status":"QUIESCENT","credentialsIncluded":false}\n');
const bytes = Buffer.alloc(64), count = readSync(checkpoint, bytes, 0, bytes.length, null);
if (!bytes.subarray(0, count).toString().includes('restore')) throw Error('RESTORE_NOTIFICATION_REQUIRED');
const environment = Object.fromEntries(readFileSync('/proc/gvisor/spec_environ', 'utf8').split('\0').filter(Boolean).map(v => {
  const at = v.indexOf('='); return [v.slice(0, at), v.slice(at + 1)];
}));
if (!/^p3-[a-f0-9-]{36}$/.test(environment.FINNOR_P3_RESTORE_ID ?? '')) throw Error('FRESH_RESTORE_ID_REQUIRED');
writeFileSync('/state/identity.json', JSON.stringify({ identity: randomUUID(), container: environment.FINNOR_P3_RESTORE_ID }));
writeFileSync('/state/restored.json', JSON.stringify({ state, identityReplaced: true }));
setInterval(() => undefined, 1000);
