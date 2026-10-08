/** Ordinary authenticated S8 service. S6 owns protected credentials/receipts. */
import { createServer } from 'node:http';
import { LedgerFault, canonical } from '../../governed-execution/src/protocol';
import { CapabilityEvolution } from './lifecycle';
import { capabilityError } from './contracts';
const config = process.env.FINNOR_S8_LIFECYCLE_CONFIG, root = process.env.FINNOR_S8_RELEASE_ROOT;
if (!config || !root)
    throw Error('S8_SIGNED_CONFIGURATION_REQUIRED');
const service = await CapabilityEvolution.open(config, root);
const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    try {
        if (req.method !== 'POST' || req.url !== '/command')
            throw new LedgerFault(404, 'S8_ROUTE_UNSUPPORTED');
        const authorization = req.headers.authorization;
        if (!authorization?.startsWith('Bearer ') || authorization.length > 8192)
            throw new LedgerFault(401, 'S8_AUTHENTICATION_REQUIRED');
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const raw of req) {
            const chunk = Buffer.from(raw);
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024)
                throw new LedgerFault(413, 'S8_REQUEST_BYTE_BOUND');
            chunks.push(chunk);
        }
        let input: any;
        try {
            input = JSON.parse(Buffer.concat(chunks).toString());
        }
        catch {
            throw new LedgerFault(400, 'S8_JSON_INVALID');
        }
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'body,operation,requestId' || typeof input.operation !== 'string' || typeof input.requestId !== 'string')
            throw new LedgerFault(400, 'S8_COMMAND_INVALID');
        const result = await service.command(authorization.slice(7), input), response = canonical(result);
        if (Buffer.byteLength(response) > 2 * 1024 * 1024)
            throw new LedgerFault(413, 'S8_RESPONSE_BYTE_BOUND');
        res.writeHead(200);
        res.end(response);
    }
    catch (error) {
        const own = error instanceof LedgerFault ? { status: error.status, body: { code: error.code, error: error.code } } : capabilityError(error);
        res.writeHead(own.status);
        res.end(JSON.stringify(own.body));
    }
});
server.requestTimeout = 10000;
server.headersTimeout = 5000;
server.maxConnections = 64;
server.listen(Number(process.env.FINNOR_S8_PORT ?? 0), '127.0.0.1', () => console.log(JSON.stringify({ status: 'READY', port: (server.address() as any).port, domain: service.policy.domain, qualification: 'ORDINARY_S8_SERVICE_NOT_PROTECTED_RELEASE' })));
let closing = false;
const stop = () => {
    if (closing)
        return;
    closing = true;
    server.close(() => { void service.close().then(() => process.exit(0)); });
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
