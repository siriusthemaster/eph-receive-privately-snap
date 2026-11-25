/**
 * ERC-5564 scheme 1 (secp256k1 with view tags) helpers.
 * Ported from ephemeral's shared/stealth.js and shared/stealth-tips.js (same math, same Announcer).
 * Stealth hides the link to the receiver. The sender, the amount and the time stay visible on-chain.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils';

export const ANNOUNCER = '0x55649E01B5Df198D18D95b5cc5051630cfD45564';
export const REGISTRY = '0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538';
export const ANNOUNCEMENT_TOPIC =
  '0x5f0eab8057630ba7676c49b4f21a0231414e79474595be8e4c432fbf6bf0f4e7';
export const SCHEME_TOPIC =
  '0x0000000000000000000000000000000000000000000000000000000000000001';
export const ETH_SELECTOR = 'eeeeeeee';
export const HONESTY =
  'Stealth hides the link between a payment and your public wallet. The sender, the amount and the time stay visible on-chain. This is not a mixer and funds are not pooled.';

const N = secp256k1.CURVE.n;
const strip0x = (h: string) => String(h).replace(/^0x/iu, '');
export const toHex = (b: Uint8Array) => `0x${bytesToHex(b)}`;

export type Keys = { pSpend: Uint8Array; pView: Uint8Array; PSpend: string; PView: string; meta: string };

/** Derive spend and view keys from 32 bytes of snap_getEntropy output (domain separated). */
export function keysFromEntropy(entropyHex: string): Keys {
  const e = hexToBytes(strip0x(entropyHex));
  if (e.length !== 32) throw new Error('entropy must be 32 bytes');
  const pSpend = keccak_256(concatBytes(e, utf8ToBytes('eph/erc5564/scheme1/spend')));
  const pView = keccak_256(concatBytes(e, utf8ToBytes('eph/erc5564/scheme1/view')));
  for (const k of [pSpend, pView]) {
    if (!secp256k1.utils.isValidPrivateKey(k)) throw new Error('derived key out of range');
  }
  const PSpend = toHex(secp256k1.getPublicKey(pSpend, true));
  const PView = toHex(secp256k1.getPublicKey(pView, true));
  return { pSpend, pView, PSpend, PView, meta: encodeMetaAddress(PSpend, PView) };
}

export function encodeMetaAddress(PSpend: string, PView: string) {
  return `0x${strip0x(PSpend)}${strip0x(PView)}`.toLowerCase();
}
export const metaUri = (meta: string) => `st:eth:${meta}`;

export function parseMetaAddress(meta: string) {
  const raw = strip0x(String(meta).trim().replace(/^st:eth:/iu, ''));
  if (!/^[0-9a-fA-F]{132}$/u.test(raw)) {
    throw new Error('Meta-address must be two compressed secp256k1 public keys (66 bytes).');
  }
  const PSpend = `0x${raw.slice(0, 66)}`;
  const PView = `0x${raw.slice(66)}`;
  secp256k1.ProjectivePoint.fromHex(raw.slice(0, 66));
  secp256k1.ProjectivePoint.fromHex(raw.slice(66));
  return { PSpend, PView };
}

export function checksumAddress(addr: string) {
  const hex = strip0x(addr).toLowerCase();
  const hash = bytesToHex(keccak_256(utf8ToBytes(hex)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i] as string, 16) >= 8 ? (hex[i] as string).toUpperCase() : hex[i];
  return out;
}

export function pointToAddress(point: InstanceType<typeof secp256k1.ProjectivePoint>) {
  const raw = point.toRawBytes(false);
  return checksumAddress(bytesToHex(keccak_256(raw.slice(1)).slice(12)));
}

function sharedHash(priv: Uint8Array, pubHex: string) {
  const secret = secp256k1.getSharedSecret(priv, strip0x(pubHex), true);
  return keccak_256(secret);
}

/** Sender side: one-time stealth address for a meta-address. */
export function generateStealthAddress(meta: string, ephemeralPriv?: Uint8Array) {
  const { PSpend, PView } = parseMetaAddress(meta);
  const pE = ephemeralPriv ?? secp256k1.utils.randomPrivateKey();
  const PE = toHex(secp256k1.getPublicKey(pE, true));
  const sh = sharedHash(pE, PView);
  const offset = secp256k1.ProjectivePoint.BASE.multiply(BigInt(toHex(sh)) % N);
  const P = secp256k1.ProjectivePoint.fromHex(strip0x(PSpend)).add(offset);
  return { stealthAddress: pointToAddress(P), ephemeralPublicKey: PE, viewTag: sh[0] as number };
}

/** Receiver side: does this announcement belong to us? Returns the stealth address on a match. */
export function checkAnnouncement(keys: Pick<Keys, 'pView' | 'PSpend'>, ephemeralPublicKey: string, viewTag: number, announced: string) {
  let sh: Uint8Array;
  try {
    sh = sharedHash(keys.pView, ephemeralPublicKey);
  } catch {
    return null;
  }
  if (sh[0] !== viewTag) return null;
  const offset = secp256k1.ProjectivePoint.BASE.multiply(BigInt(toHex(sh)) % N);
  const addr = pointToAddress(secp256k1.ProjectivePoint.fromHex(strip0x(keys.PSpend)).add(offset));
  return addr.toLowerCase() === announced.toLowerCase() ? addr : null;
}

/** Stealth private key = p_spend + s_h mod n. Only used inside the snap, never returned to a dapp. */
export function stealthPrivateKey(keys: Pick<Keys, 'pSpend' | 'pView'>, ephemeralPublicKey: string) {
  const sh = sharedHash(keys.pView, ephemeralPublicKey);
  const k = (BigInt(toHex(keys.pSpend)) + BigInt(toHex(sh))) % N;
  return hexToBytes(k.toString(16).padStart(64, '0'));
}

export type Announcement = {
  stealthAddress: string;
  caller: string;
  ephemeralPublicKey: string;
  metadata: string;
  viewTag: number;
  token: string | null;
  blockNumber: number;
  txHash: string;
};

/** Decode an Announcement(uint256 indexed,address indexed,address indexed,bytes,bytes) log. */
export function decodeAnnouncementLog(log: { topics: string[]; data: string; blockNumber: string; transactionHash: string }): Announcement | null {
  if (!log?.topics || log.topics.length < 4) return null;
  if (String(log.topics[0]).toLowerCase() !== ANNOUNCEMENT_TOPIC) return null;
  const d = strip0x(log.data);
  const word = (i: number) => d.slice(i * 64, i * 64 + 64);
  const readBytes = (offsetBytes: number) => {
    const at = offsetBytes * 2;
    const len = parseInt(d.slice(at, at + 64), 16);
    return d.slice(at + 64, at + 64 + len * 2);
  };
  try {
    const e = readBytes(parseInt(word(0), 16));
    const m = readBytes(parseInt(word(1), 16));
    if (m.length < 2) return null;
    let token: string | null = null;
    if (m.length >= 50 && m.slice(2, 10).toLowerCase() !== ETH_SELECTOR) token = checksumAddress(m.slice(10, 50));
    return {
      stealthAddress: checksumAddress(String(log.topics[2]).slice(-40)),
      caller: checksumAddress(String(log.topics[3]).slice(-40)),
      ephemeralPublicKey: `0x${e}`,
      metadata: `0x${m}`,
      viewTag: parseInt(m.slice(0, 2), 16),
      token,
      blockNumber: parseInt(log.blockNumber, 16),
      txHash: log.transactionHash,
    };
  } catch {
    return null;
  }
}

/** ABI-encode Announcement log data (used by tests and by the pay link page). */
export function encodeAnnouncementData(ephemeralPublicKey: string, metadata: string) {
  const enc = (hex: string) => {
    const h = strip0x(hex);
    const len = (h.length / 2).toString(16).padStart(64, '0');
    return len + h.padEnd(Math.ceil(h.length / 64) * 64, '0');
  };
  const a = enc(ephemeralPublicKey);
  const b = enc(metadata);
  const off1 = (64).toString(16).padStart(64, '0');
  const off2 = (64 + a.length / 2).toString(16).padStart(64, '0');
  return `0x${off1}${off2}${a}${b}`;
}

/** Pay link. Everything after # stays in the browser and is never sent to a server. */
export function payLink(meta: string, opts: { amount?: string; note?: string; host?: string } = {}) {
  const q = new URLSearchParams({ m: metaUri(meta) });
  if (opts.amount) q.set('a', opts.amount);
  if (opts.note) q.set('n', opts.note.slice(0, 80));
  return `${opts.host ?? 'https://eph.money'}/r#${q.toString()}`;
}
