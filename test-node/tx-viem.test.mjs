// Independent cross-check: transactions signed by src/tx.ts are parsed and recovered by viem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTransaction, recoverTransactionAddress, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const out = join(mkdtempSync(join(tmpdir(), 'tx-')), 'tx.mjs');
await build({ entryPoints: ['src/tx.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const T = await import(out);

const PK = '0x' + '4c'.repeat(32);
const acct = privateKeyToAccount(PK);
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));

for (const [name, tx] of [
  ['eth sweep', { chainId: 1n, nonce: 0n, maxPriorityFeePerGas: 12_000_000_000n, maxFeePerGas: 12_000_000_000n, gasLimit: 21000n, to: '0x1111111111111111111111111111111111111111', value: 987654321000000n, data: '0x' }],
  ['usdc transfer', { chainId: 1n, nonce: 7n, maxPriorityFeePerGas: 3_000_000_000n, maxFeePerGas: 3_000_000_000n, gasLimit: 78000n, to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', value: 0n, data: '0xa9059cbb' + '22'.repeat(20).padStart(64, '0') + (25_000_000n).toString(16).padStart(64, '0') }],
]) {
  test(`viem parses and recovers: ${name}`, async () => {
    const raw = T.signTx1559(tx, hexToBytes(PK));
    const p = parseTransaction(raw);
    assert.equal(p.type, 'eip1559');
    assert.equal(p.to.toLowerCase(), tx.to.toLowerCase());
    assert.equal(p.value ?? 0n, tx.value);
    assert.equal(p.nonce ?? 0, Number(tx.nonce));
    assert.equal(p.gas, tx.gasLimit);
    assert.equal(p.maxFeePerGas, tx.maxFeePerGas);
    assert.equal(p.chainId, 1);
    const from = await recoverTransactionAddress({ serializedTransaction: raw });
    assert.equal(from, acct.address);
    // and viem's own signer produces the same bytes (deterministic RFC6979 signatures)
    const viemRaw = await acct.signTransaction({ type: 'eip1559', chainId: 1, nonce: Number(tx.nonce), maxPriorityFeePerGas: tx.maxPriorityFeePerGas, maxFeePerGas: tx.maxFeePerGas, gas: tx.gasLimit, to: tx.to, value: tx.value, data: tx.data });
    assert.equal(keccak256(raw), keccak256(viemRaw));
  });
}
