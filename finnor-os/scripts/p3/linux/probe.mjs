/** Fixed hostile probes, reachable only by the trusted Linux certifier. */
import { readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
const chunks = []; let size = 0;
for await (const raw of process.stdin) { size += raw.length; if (size > 8192) throw Error('PROBE_INPUT_BOUND'); chunks.push(raw); }
const input = JSON.parse(Buffer.concat(chunks));
if (Object.keys(input).sort().join() !== 'hostSentinel,probe,tag,tripwirePort' ||
  !Number.isInteger(input.tripwirePort) || input.tripwirePort < 1 || input.tripwirePort > 65535 ||
  !/^p3-[a-f0-9-]{36}$/.test(input.tag) || !/^\/[A-Za-z0-9_./-]+$/.test(input.hostSentinel)) throw Error('FIXED_PROBE_PROTOCOL_REQUIRED');
const results = [];
const observe = async (name, fn) => { try { await fn(); results.push({ name, denied: false }); } catch { results.push({ name, denied: true }); } };
switch (input.probe) {
  case 'egress':
    for (const stage of ['autosave', 'background', 'navigate', 'submit']) await observe(stage, () =>
      fetch(`http://127.0.0.1:${input.tripwirePort}/lender/${stage}?tag=${input.tag}`, {
        method: stage === 'navigate' || stage === 'background' ? 'GET' : 'POST', signal: AbortSignal.timeout(500),
      }).then(r => { if (!r.ok) throw Error('DENIED'); }));
    await observe('dns', () => lookup('p3-nonexistent.example.test'));
    await observe('ipv6', () => fetch(`http://[::1]:${input.tripwirePort}/lender/ipv6?tag=${input.tag}`, { signal: AbortSignal.timeout(500) }));
    await observe('metadata', () => fetch('http://169.254.169.254/latest/meta-data/', { signal: AbortSignal.timeout(500) }));
    await observe('redirect', () => fetch(`http://127.0.0.1:${input.tripwirePort}/redirect?tag=${input.tag}`, { signal: AbortSignal.timeout(500) }));
    await observe('websocket', () => new Promise((yes, no) => {
      const socket = new WebSocket(`ws://127.0.0.1:${input.tripwirePort}/lender/websocket?tag=${input.tag}`);
      const timer = setTimeout(() => { socket.close(); no(Error('DENIED')); }, 500);
      socket.onopen = () => { clearTimeout(timer); socket.close(); yes(); };
      socket.onerror = () => { clearTimeout(timer); no(Error('DENIED')); };
    }));
    break;
  case 'host':
    await observe('host-sentinel', () => readFile(input.hostSentinel));
    await observe('docker-socket', () => new Promise((yes, no) => {
      const socket = connect('/var/run/docker.sock'); socket.once('connect', () => { socket.destroy(); yes(); }); socket.once('error', no);
    }));
    await symlink(input.hostSentinel, '/state/escape');
    await observe('symlink-host-sentinel', () => readFile('/state/escape'));
    await observe('read-only-root', () => writeFile('/app/forged.mjs', 'forged'));
    break;
  case 'storage':
    await observe('tmpfs-byte-bound', async () => { for (let i = 0; i < 128; i++) await writeFile('/state/bytes-' + i, Buffer.alloc(1024 * 1024, 17)); });
    break;
  case 'inodes':
    await observe('tmpfs-inode-bound', async () => { for (let i = 0; i < 4096; i++) await mkdir('/state/inode-' + i); });
    break;
  case 'output':
    for (;;) process.stdout.write(Buffer.alloc(65536, 65));
  case 'memory': {
    const retained = []; for (;;) retained.push(Buffer.alloc(64 * 1024 * 1024, 17));
  }
  case 'descendants':
    for (let i = 0; i < 128; i++) {
      const child = spawn('/bin/node', ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      child.on('error', () => undefined);
    }
    setInterval(() => undefined, 1000); break;
  case 'wall':
    for (;;) {}
  default: throw Error('UNREGISTERED_PROBE');
}
if (!['descendants', 'wall', 'output', 'memory'].includes(input.probe)) {
  process.stdout.write(JSON.stringify({ schema: 'finnor.p3.hostile-probe.v1', probe: input.probe, results }));
}
