import { readFileSync } from 'node:fs';
let restored = null;
try { restored = JSON.parse(readFileSync('/state/restored.json', 'utf8')); } catch {}
process.stdout.write(JSON.stringify({
  state: JSON.parse(readFileSync('/state/state.json', 'utf8')),
  identity: JSON.parse(readFileSync('/state/identity.json', 'utf8')),
  restored,
}));
