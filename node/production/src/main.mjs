import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTransactionPreparer, requestEthereumJsonRpc } from '@oyaprotocol/ethereum';
import { loadConfig } from './config.mjs';
import { createLocalSigner } from './signer.mjs';
import { createNodeServer } from './server.mjs';

export async function startNode(config, signer, { fetch = globalThis.fetch, log } = {}) {
    const rpc = async (method, params = []) => (await requestEthereumJsonRpc({
        config: config.rpc, fetch, method, params,
    })).result;
    if (BigInt(await rpc('eth_chainId')) !== BigInt(config.chainId)) throw new Error('RPC chain ID does not match configuration.');
    const code = await rpc('eth_getCode', [config.loggerContract, 'latest']);
    if (typeof code !== 'string' || !/^0x[0-9a-fA-F]+$/.test(code) || code === '0x0') {
        throw new Error('No contract bytecode exists at loggerContract.');
    }
    const transactionPreparer = createTransactionPreparer({
        config: config.rpc, fetch, chainId: config.chainId, signer, limits: config.limits,
    });
    const runtime = createNodeServer({ config, transactionPreparer, nodeAddress: signer.address, fetch, log });
    await new Promise((resolveListening, reject) => {
        runtime.server.once('error', reject);
        runtime.server.listen(config.port, config.host, resolveListening);
    });
    return runtime;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw new Error('Usage: npm start -- /absolute/path/to/config.json');
    const config = await loadConfig(args[0]);
    const signer = createLocalSigner(process.env.OYA_NODE_PRIVATE_KEY);
    const runtime = await startNode(config, signer);
    console.log(JSON.stringify({
        event: 'listening', host: config.host, port: config.port, chainId: config.chainId,
        loggerContract: config.loggerContract, nodeAddress: signer.address,
    }));
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        // Drain accepted work even when its client has already disconnected.
        runtime.close().catch(() => { process.exitCode = 1; });
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(() => {
        // RPC URLs, IPFS headers, and wallet errors may contain secrets.
        console.error('Node startup failed. Check config, signer, and RPC/Logger availability.');
        process.exitCode = 1;
    });
}
