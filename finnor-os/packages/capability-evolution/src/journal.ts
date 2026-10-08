/** Ordinary durable S8 journal. Its OS administrator is not a protected adversary. */
import { open, mkdir, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { join, resolve } from 'node:path';
import { canonical } from '../../governed-execution/src/protocol';
import { digest, fault } from './contracts';
export async function privateFile(path: string, limit = 8 * 1024 * 1024) {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const st = await fd.stat();
        if (!st.isFile() || st.size > limit || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.())
            fault('UNSAFE_S8_PRIVATE_FILE', 503);
        const bytes = await fd.readFile();
        if (bytes.length > limit)
            fault('S8_FILE_BYTE_LIMIT', 503);
        return bytes;
    }
    finally {
        await fd.close();
    }
}
export interface JournalEntry {
    sequence: number;
    previous: string | null;
    policyDigest: string;
    requestId: string;
    requestDigest: string;
    actorId: string;
    operation: string;
    body: any;
    result: any;
    knowledgeAt: string;
    digest: string;
    signature: string;
}
export class CapabilityJournal {
    private constructor(private fd: Awaited<ReturnType<typeof open>>, private lock: Awaited<ReturnType<typeof open>>, private path: string, private signer: ReturnType<typeof createPrivateKey>, private publicKey: string, readonly policyDigest: string, readonly maxEntries: number, readonly entries: JournalEntry[]) { }
    static async open(directory: string, signerPath: string, publicKey: string, policyDigest: string, maxEntries: number, authorizeTornRecovery?: (tail: JournalEntry | null, discarded: {
        bytes: number;
        sha256: string;
    }) => Promise<void>) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const st = await lstat(directory);
        if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || await realpath(directory) !== resolve(directory))
            fault('UNSAFE_S8_DIRECTORY', 503);
        const key = createPrivateKey(await privateFile(signerPath));
        if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString() !== publicKey)
            fault('S8_JOURNAL_SIGNER_MISMATCH', 503);
        const lock = await open(join(directory, 'writer.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        try {
            createRequire(import.meta.url)('fs-ext').flockSync(lock.fd, 'exnb');
        }
        catch {
            await lock.close();
            fault('S8_WRITER_ALREADY_ACTIVE', 503);
        }
        let fd: Awaited<ReturnType<typeof open>> | null = null;
        try {
            fd = await open(join(directory, 'history.jsonl'), constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
            const stat = await fd.stat();
            if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || (stat.mode & 0o077) !== 0)
                fault('S8_JOURNAL_BYTE_OR_TYPE_BOUND', 503);
            const raw = (await fd.readFile()).toString(), entries: JournalEntry[] = [], torn = raw !== '' && !raw.endsWith('\n'), prefix = torn ? raw.slice(0, raw.lastIndexOf('\n') + 1) : raw;
            if (torn && !authorizeTornRecovery)
                fault('S8_TORN_JOURNAL_REQUIRES_RECOVERY', 503);
            for (const line of prefix.split('\n').filter(Boolean)) {
                const entry = JSON.parse(line) as JournalEntry;
                const { digest: stored, signature, ...body } = entry;
                if (entry.sequence !== entries.length + 1 || entry.previous !== (entries.at(-1)?.digest ?? null) || entry.policyDigest !== policyDigest || stored !== digest(body) || !verify(null, Buffer.from(canonical({ ...body, digest: stored })), publicKey, Buffer.from(signature, 'base64')))
                    fault('S8_HISTORY_SIGNATURE_OR_ORDER_INVALID', 503);
                entries.push(entry);
                if (entries.length > maxEntries)
                    fault('S8_JOURNAL_RETENTION_BOUND', 503);
            }
            if (torn) {
                if (prefix !== entries.map(e => canonical(e) + '\n').join(''))
                    fault('S8_TORN_PREFIX_NOT_CANONICAL', 503);
                const discarded = Buffer.from(raw.slice(prefix.length));
                await authorizeTornRecovery!(entries.at(-1) ?? null, { bytes: discarded.length, sha256: (await import('./contracts')).byteDigest(discarded) });
                await fd.truncate(Buffer.byteLength(prefix));
                await fd.sync();
            }
            return new CapabilityJournal(fd, lock, join(directory, 'history.jsonl'), key, publicKey, policyDigest, maxEntries, entries);
        }
        catch (error) {
            await fd?.close();
            await lock.close();
            throw error;
        }
    }
    async assertIntegrity() {
        const fdStat = await this.fd.stat(), pathStat = await lstat(this.path);
        if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino || fdStat.size > 64 * 1024 * 1024)
            fault('S8_JOURNAL_PATH_OR_INODE_CHANGED', 503);
        const expected = this.entries.map(e => canonical(e) + '\n').join('');
        if (fdStat.size !== Buffer.byteLength(expected))
            fault('S8_LIVE_JOURNAL_TRUNCATION_OR_GROWTH', 503);
        const bytes = Buffer.alloc(fdStat.size);
        let offset = 0;
        while (offset < bytes.length) {
            const read = await this.fd.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
            if (!read.bytesRead)
                fault('S8_LIVE_JOURNAL_READ_TRUNCATED', 503);
            offset += read.bytesRead;
        }
        if (bytes.toString() !== expected)
            fault('S8_LIVE_JOURNAL_CONTENT_SUBSTITUTION', 503);
    }
    async append(input: Omit<JournalEntry, 'sequence' | 'previous' | 'policyDigest' | 'digest' | 'signature' | 'knowledgeAt'>) {
        await this.assertIntegrity();
        if (this.entries.length >= this.maxEntries)
            fault('S8_JOURNAL_RETENTION_BOUND', 429);
        const body = { ...input, sequence: this.entries.length + 1, previous: this.entries.at(-1)?.digest ?? null, policyDigest: this.policyDigest, knowledgeAt: new Date().toISOString() }, hashed = { ...body, digest: digest(body) }, entry = { ...hashed, signature: sign(null, Buffer.from(canonical(hashed)), this.signer).toString('base64') };
        const bytes = canonical(entry) + '\n';
        if (Buffer.byteLength(bytes) > 2 * 1024 * 1024)
            fault('S8_JOURNAL_ENTRY_BOUND', 413);
        if ((await this.fd.stat()).size + Buffer.byteLength(bytes) > 64 * 1024 * 1024)
            fault('S8_JOURNAL_BYTE_BOUND', 429);
        await this.fd.writeFile(bytes);
        await this.fd.sync();
        this.entries.push(entry);
        return entry;
    }
    async close() { await this.fd.close(); await this.lock.close(); }
}
