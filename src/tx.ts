/**
 * Minimal EIP-1559 (type 2) transaction signing for withdrawals from one-time addresses.
 * Runs only inside the snap. The private key never leaves this module's caller.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils';

type RlpInput = Uint8Array | RlpInput[];

const strip = (h: string) => h.replace(/^0x/iu, '');

export function bigToBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('negative');
  if (n === 0n) return new Uint8Array(0);
  let h = n.toString(16);
  if (h.length % 2) h = `0${h}`;
  return hexToBytes(h);
}

function lenPrefix(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.of(offset + len);
  const l = bigToBytes(BigInt(len));
  return concatBytes(Uint8Array.of(offset + 55 + l.length), l);
}

export function rlp(input: RlpInput): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 1 && (input[0] as number) < 0x80) return input;
    return concatBytes(lenPrefix(input.length, 0x80), input);
  }
  const body = concatBytes(...input.map(rlp));
  return concatBytes(lenPrefix(body.length, 0xc0), body);
}

export type Tx1559 = {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string;
  value: bigint;
  data: string;
};

function fields(tx: Tx1559): RlpInput[] {
  return [
    bigToBytes(tx.chainId),
    bigToBytes(tx.nonce),
    bigToBytes(tx.maxPriorityFeePerGas),
    bigToBytes(tx.maxFeePerGas),
    bigToBytes(tx.gasLimit),
    hexToBytes(strip(tx.to)),
    bigToBytes(tx.value),
    hexToBytes(strip(tx.data || '0x')),
    [],
  ];
}

export function signingHash(tx: Tx1559): Uint8Array {
  return keccak_256(concatBytes(Uint8Array.of(2), rlp(fields(tx))));
}

/** Returns the raw signed transaction as 0x hex, ready for eth_sendRawTransaction. */
export function signTx1559(tx: Tx1559, privateKey: Uint8Array): string {
  const sig = secp256k1.sign(signingHash(tx), privateKey, { lowS: true });
  const signed = [...fields(tx), bigToBytes(BigInt(sig.recovery)), bigToBytes(sig.r), bigToBytes(sig.s)];
  return `0x02${bytesToHex(rlp(signed))}`;
}

/** Decode helpers used by tests and by the review screen. */
export function rlpDecode(b: Uint8Array): { item: Uint8Array | any[]; rest: Uint8Array } {
  const p = b[0] as number;
  const readLen = (n: number, off: number) => [Number(BigInt(`0x${bytesToHex(b.slice(1, 1 + n))}`)), 1 + n + off] as const;
  if (p < 0x80) return { item: b.slice(0, 1), rest: b.slice(1) };
  if (p < 0xb8) return { item: b.slice(1, 1 + p - 0x80), rest: b.slice(1 + p - 0x80) };
  if (p < 0xc0) {
    const [len, start] = readLen(p - 0xb7, 0);
    return { item: b.slice(start, start + len), rest: b.slice(start + len) };
  }
  let len: number;
  let start: number;
  if (p < 0xf8) {
    len = p - 0xc0;
    start = 1;
  } else {
    [len, start] = readLen(p - 0xf7, 0);
  }
  let body = b.slice(start, start + len);
  const items: any[] = [];
  while (body.length) {
    const r = rlpDecode(body);
    items.push(r.item);
    body = r.rest;
  }
  return { item: items, rest: b.slice(start + len) };
}

export function decodeSignedTx1559(raw: string) {
  const b = hexToBytes(strip(raw));
  if (b[0] !== 2) throw new Error('not a type 2 tx');
  const f = rlpDecode(b.slice(1)).item as Uint8Array[];
  const big = (x: Uint8Array) => (x.length ? BigInt(`0x${bytesToHex(x)}`) : 0n);
  const tx: Tx1559 = {
    chainId: big(f[0] as Uint8Array),
    nonce: big(f[1] as Uint8Array),
    maxPriorityFeePerGas: big(f[2] as Uint8Array),
    maxFeePerGas: big(f[3] as Uint8Array),
    gasLimit: big(f[4] as Uint8Array),
    to: `0x${bytesToHex(f[5] as Uint8Array)}`,
    value: big(f[6] as Uint8Array),
    data: `0x${bytesToHex(f[7] as Uint8Array)}`,
  };
  const recovery = Number(big(f[9] as Uint8Array));
  const sig = new secp256k1.Signature(big(f[10] as Uint8Array), big(f[11] as Uint8Array)).addRecoveryBit(recovery);
  const pub = sig.recoverPublicKey(signingHash(tx)).toRawBytes(false);
  const from = `0x${bytesToHex(keccak_256(pub.slice(1)).slice(12))}`;
  return { tx, from };
}
