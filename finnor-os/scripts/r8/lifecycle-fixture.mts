/** R8-exclusive disposable fixture of the real shared lifecycle process.
 * Creates no scientific admission; retains bounded child diagnostics. */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { canonical } from '../../packages/governed-execution/src/protocol';
import { byteDigest } from '../../packages/capability-evolution/src/contracts';
export async function createCapabilityLifecycle(input: {
    tenant: string;
    principal: string;
    evaluator: string;
    promoter: string;
    rightsRef: string;
    protectedEvents?: { contract: 'S8_CAPABILITY_EVENTS_V1'; maxRecoveryEvents: number };
    solverReview?: { contract: 's8-r8-solver-module-review-v1'; sourcePins: Array<{path:string;sha256:string}> };
    sourcePins: Array<{
        path: string;
        sha256: string;
    }>;
}) {
    const { tenant, principal, evaluator, promoter } = input;
    const root = await realpath(await mkdtemp(join(tmpdir(), 'finnor-s8-lifecycle-'))), keys = Object.fromEntries(['release', 'journal', 'evaluator', 'promoter'].map(id => [id, generateKeyPairSync('ed25519')]));
    const pub = (name: string) => keys[name]!.publicKey.export({ type: 'spki', format: 'pem' }).toString(), signed = (body: any, name: string) => ({ body, keyId: name, signature: sign(null, Buffer.from(canonical(body)), keys[name]!.privateKey).toString('base64') });
    const tokens = Object.fromEntries(['proposer', 'evaluator', 'promoter', 'consumer', 'reader'].map(id => [id, randomUUID() + randomUUID()]));
    const after = new Date(Date.now() - 60000).toISOString(), until = new Date(Date.now() + 3600000).toISOString();
    const policy = { schema: 'finnor.s8.lifecycle-policy.v1', domain: 'DISPOSABLE_TEST_AUTHORITY', tenantId: tenant, principalId: principal, rightsRef: input.rightsRef, ...(input.protectedEvents ? { protectedEvents: input.protectedEvents } : {}), ...(input.solverReview ? {solverReview:input.solverReview} : {}), validAfter: after, validUntil: until, actors: Object.entries(tokens).map(([id, token]) => ({ id, principalId: id === 'evaluator' ? evaluator : id === 'promoter' ? promoter : principal, tokenHash: byteDigest(token), roles: [id.toUpperCase()] })), evaluatorKeys: [{ id: 'evaluator', principalId: evaluator, publicKey: pub('evaluator'), validAfter: after, validUntil: until, revoked: false }], promotionKeys: [{ id: 'promoter', principalId: promoter, publicKey: pub('promoter'), validAfter: after, validUntil: until, revoked: false }], costAuthorityPrincipalIds: [evaluator], journalPublicKey: pub('journal'), allowedStrata: ['coupled', 'prior-regime'], maxEntries: 20000, maxQueue: 4, maxTotalCost: 100, maxTotalLoss: 5, maxTotalUses: 50, sourcePins: input.sourcePins };
    const configPath = join(root, 'config.json'), signerPath = join(root, 'journal.pem');
    await writeFile(signerPath, keys.journal!.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await writeFile(configPath, JSON.stringify({ signedPolicy: signed(policy, 'release'), directory: join(root, 'journal'), signerPath }), { mode: 0o600 });
    let child: ChildProcess | null = null, endpoint = '', logs = '', stderr = '';
    const exits:Array<{pid:number|undefined;code:number|null;signal:string|null;at:string}>=[];
    const redact=(text:string)=>Object.values(tokens).reduce((value,token)=>value.replaceAll(token,'[DISPOSABLE_TOKEN_REDACTED]'),text);
    const snapshot=()=>({pid:child?.pid??null,exitCode:child?.exitCode??null,signalCode:child?.signalCode??null,
        connected:child?.connected??false,endpoint,exits:[...exits],logs:redact(logs),stderr:redact(stderr),
        logScope:'BOUNDED_DISPOSABLE_PROCESS_DIAGNOSTICS_NOT_PROTECTED_CUSTODY'});
    async function start() {
        logs = '';stderr = '';
        child = spawn(process.execPath, ['--import=tsx', 'packages/capability-evolution/src/server.mts'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, DATABASE_URL: process.env.DATABASE_URL, FINNOR_S3_MODEL_STORE: process.env.FINNOR_S3_MODEL_STORE, FINNOR_S4_POLICY_STORE: process.env.FINNOR_S4_POLICY_STORE, FINNOR_R8_RUNTIME_MANIFEST:process.env.FINNOR_R8_RUNTIME_MANIFEST, FINNOR_S8_LIFECYCLE_CONFIG: configPath, FINNOR_S8_RELEASE_ROOT: pub('release'), FINNOR_S6_OWNER_TRANSPORT_CONFIG: process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG, FINNOR_S6_OWNER_TRANSPORT_ROOT: process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT }, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise<void>((ok, fail) => {
            const timer = setTimeout(() => fail(Error('S8_BOOT_TIMEOUT:' + logs)), 15000);
            child!.stdout!.on('data', b => {
                logs = (logs+b.toString()).slice(-131072);
                for (const line of logs.split('\n'))
                    try {
                        const state = JSON.parse(line);
                        if (state.status === 'READY') {
                            endpoint = 'http://127.0.0.1:' + state.port;
                            clearTimeout(timer);
                            ok();
                        }
                    }
                    catch { }
            });
            child!.stderr!.on('data', b => { stderr=(stderr+b.toString()).slice(-131072);logs=(logs+b.toString()).slice(-131072); });
            child!.once('exit', (code,signal) => {
                exits.push({pid:child?.pid,code,signal,at:new Date().toISOString()});
                clearTimeout(timer);fail(Error('S8_BOOT_EXIT:' + redact(logs)));
            });
        });
    }
    async function stop() {
        if (!child || child.exitCode !== null || child.signalCode !== null)
            return;
        await new Promise<void>(ok => { child!.once('close', () => ok()); child!.kill('SIGKILL'); });
    }
    return { root, keys, pub, signed, tokens, after, until, policy, configPath, start, stop, snapshot, endpoint: () => endpoint };
}
