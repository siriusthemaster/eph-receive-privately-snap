import { describe, expect, it } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hexToBytes } from '@noble/hashes/utils';

import {
  ANNOUNCEMENT_TOPIC,
  checkAnnouncement,
  decodeAnnouncementLog,
  encodeAnnouncementData,
  generateStealthAddress,
  keysFromEntropy,
  parseMetaAddress,
  payLink,
  pointToAddress,
  stealthPrivateKey,
} from './stealth';

// Worked example used by ephemeral.money and ScopeLift (shared/stealth.js WORKED_EXAMPLE).
const WE = {
  PSpend: '0x023be430d8668638a68ff14b443d0751feb962baac1ef8b19f7689b98ab7372672',
  sh: '0xc17d8e71241c4fefb2a5c06f3080e359ec67ce42f3123736d6381ce5af956076',
  stealth: '0xF236126F35184De906A7Cdeb00432a682F8352F4',
};
const ENTROPY = `0x${'11'.repeat(32)}`;

describe('ERC-5564 scheme 1', () => {
  it('matches the worked example vector (P_spend + s_h*G)', () => {
    const P = secp256k1.ProjectivePoint.fromHex(WE.PSpend.slice(2)).add(secp256k1.ProjectivePoint.BASE.multiply(BigInt(WE.sh)));
    expect(pointToAddress(P)).toBe(WE.stealth);
  });

  it('derives deterministic keys and a valid 66 byte meta-address', () => {
    const a = keysFromEntropy(ENTROPY);
    const b = keysFromEntropy(ENTROPY);
    expect(a.meta).toBe(b.meta);
    expect(a.meta).toMatch(/^0x[0-9a-f]{132}$/u);
    expect(parseMetaAddress(`st:eth:${a.meta}`).PSpend).toBe(a.PSpend);
  });

  it('sender and receiver agree, and the stealth key controls the address', () => {
    const k = keysFromEntropy(ENTROPY);
    const s = generateStealthAddress(k.meta);
    expect(checkAnnouncement(k, s.ephemeralPublicKey, s.viewTag, s.stealthAddress)).toBe(s.stealthAddress);
    const priv = stealthPrivateKey(k, s.ephemeralPublicKey);
    const addr = pointToAddress(secp256k1.ProjectivePoint.fromHex(secp256k1.getPublicKey(priv, false)));
    expect(addr).toBe(s.stealthAddress);
  });

  it('ignores payments for someone else', () => {
    const mine = keysFromEntropy(ENTROPY);
    const other = keysFromEntropy(`0x${'22'.repeat(32)}`);
    const s = generateStealthAddress(other.meta);
    expect(checkAnnouncement(mine, s.ephemeralPublicKey, s.viewTag, s.stealthAddress)).toBeNull();
  });

  it('decodes an Announcer log', () => {
    const k = keysFromEntropy(ENTROPY);
    const s = generateStealthAddress(k.meta, hexToBytes('33'.repeat(32)));
    const meta = `0x${s.viewTag.toString(16).padStart(2, '0')}eeeeeeee${'ee'.repeat(20)}${'00'.repeat(31)}01`;
    const log = {
      topics: [ANNOUNCEMENT_TOPIC, `0x${'0'.repeat(63)}1`, `0x${'0'.repeat(24)}${s.stealthAddress.slice(2)}`, `0x${'0'.repeat(24)}${'ab'.repeat(20)}`],
      data: encodeAnnouncementData(s.ephemeralPublicKey, meta),
      blockNumber: '0x10',
      transactionHash: `0x${'cd'.repeat(32)}`,
    };
    const a = decodeAnnouncementLog(log);
    expect(a?.ephemeralPublicKey).toBe(s.ephemeralPublicKey);
    expect(a?.viewTag).toBe(s.viewTag);
    expect(a?.token).toBeNull();
    expect(a?.stealthAddress.toLowerCase()).toBe(s.stealthAddress.toLowerCase());
  });

  it('builds a pay link that keeps data after #', () => {
    const k = keysFromEntropy(ENTROPY);
    const l = payLink(k.meta, { amount: '0.05', note: 'Invoice 12' });
    expect(l.startsWith('https://eph.money/r#m=st%3Aeth%3A0x')).toBe(true);
    expect(l).toContain('a=0.05');
  });
});

describe('real mainnet Announcer logs (public chain data fixture)', () => {
  it('decodes every scheme 1 log with a 33 byte ephemeral key and a view tag', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const logs = require('../test-fixtures/mainnet-announcer-logs.json').result as any[];
    const s1 = logs.filter((l) => l.topics?.[1] === `0x${'0'.repeat(63)}1`);
    expect(s1.length).toBeGreaterThan(0);
    const decoded = s1.map(decodeAnnouncementLog);
    for (const a of decoded) {
      expect(a).not.toBeNull();
      expect(a!.ephemeralPublicKey).toMatch(/^0x0[23][0-9a-f]{64}$/u);
      expect(a!.viewTag).toBeGreaterThanOrEqual(0);
    }
    // a stranger's keys must not claim any of them
    const k = keysFromEntropy(ENTROPY);
    expect(decoded.filter((a) => checkAnnouncement(k, a!.ephemeralPublicKey, a!.viewTag, a!.stealthAddress))).toHaveLength(0);
  });
});
