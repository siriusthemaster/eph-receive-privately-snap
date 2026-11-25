import { describe, expect, it } from '@jest/globals';
import { installSnap } from '@metamask/snaps-jest';

import { ANNOUNCEMENT_TOPIC, encodeAnnouncementData, generateStealthAddress, keysFromEntropy } from './stealth';

const text = (x: unknown) => JSON.stringify(x);

async function confirmAnd(snapReq: any) {
  const ui = await snapReq.getInterface();
  expect(ui.type).toBe('confirmation');
  await ui.ok();
  return snapReq;
}

function logFor(meta: string, block: number) {
  const s = generateStealthAddress(meta);
  const md = `0x${s.viewTag.toString(16).padStart(2, '0')}eeeeeeee${'ee'.repeat(20)}${'0'.repeat(48)}38d7ea4c68000`;
  return {
    s,
    log: {
      address: '0x55649E01B5Df198D18D95b5cc5051630cfD45564',
      topics: [ANNOUNCEMENT_TOPIC, `0x${'0'.repeat(63)}1`, `0x${'0'.repeat(24)}${s.stealthAddress.slice(2).toLowerCase()}`, `0x${'0'.repeat(24)}${'ab'.repeat(20)}`],
      data: encodeAnnouncementData(s.ephemeralPublicKey, md),
      blockNumber: `0x${block.toString(16)}`,
      transactionHash: `0x${'cd'.repeat(32)}`,
      logIndex: '0x0',
    },
  };
}

describe('Receive privately snap', () => {
  it('shares the meta-address only after the user confirms', async () => {
    const { request } = await installSnap();
    const r = await confirmAnd(request({ method: 'getMetaAddress', origin: 'https://eph.money' }));
    const res: any = await r;
    expect(res.response.result.schemeId).toBe(1);
    expect(res.response.result.metaAddress).toMatch(/^st:eth:0x[0-9a-f]{132}$/u);
  });

  it('returns an error when the user declines', async () => {
    const { request } = await installSnap();
    const p = request({ method: 'getPayLink', origin: 'https://example.com', params: { amount: '0.1' } });
    const ui: any = await p.getInterface();
    await ui.cancel();
    expect(await p).toRespondWithError(expect.objectContaining({ code: 4001 }));
  });

  it('creates a pay link with an amount', async () => {
    const { request } = await installSnap();
    const res: any = await confirmAnd(request({ method: 'getPayLink', origin: 'https://eph.money', params: { amount: '0.05', note: 'Invoice 12' } })).then((x) => x);
    const out = (await res).response.result;
    expect(out.link).toMatch(/^https:\/\/eph\.money\/r#m=st%3Aeth%3A0x[0-9a-f]{132}&a=0\.05&n=Invoice\+12$/u);
  });

  it('home page: finds our payment, skips a stranger, shows balance', async () => {
    const snap = await installSnap();
    const metaRes: any = await confirmAnd(snap.request({ method: 'getMetaAddress', origin: 'https://eph.money' }));
    const meta = String((await metaRes).response.result.metaAddress).replace('st:eth:', '');
    const ours = logFor(meta, 21_000_100);
    const stranger = logFor(keysFromEntropy(`0x${'44'.repeat(32)}`).meta, 21_000_200);
    snap.mockJsonRpc((req: any) => {
      if (req.method === 'eth_blockNumber') return '0x1408e80'; // block 21008000
      if (req.method === 'eth_getLogs') {
        const from = parseInt(req.params[0].fromBlock, 16);
        const to = parseInt(req.params[0].toBlock, 16);
        return [ours.log, stranger.log].filter((l) => {
          const b = parseInt(l.blockNumber, 16);
          return b >= from && b <= to;
        });
      }
      if (req.method === 'eth_getBalance') return req.params[0].toLowerCase() === ours.s.stealthAddress.toLowerCase() ? '0x38d7ea4c68000' : '0x0';
      return undefined;
    });
    const home = await snap.onHomePage();
    const ui = home.getInterface();
    expect(text(ui.content)).toContain('Receive privately');
    expect(text(ui.content)).toContain('No payments found yet.');
    await ui.clickElement('scan');
    const after = home.getInterface();
    const t = text(after.content).toLowerCase();
    expect(t).toContain(ours.s.stealthAddress.toLowerCase().slice(2, 10));
    expect(t).not.toContain(stranger.s.stealthAddress.toLowerCase().slice(2, 10));
    expect(t).toContain("0.001 eth");
    expect(t).toContain("checked 2 announcements");
  });

  it('home page form makes a pay link', async () => {
    const snap = await installSnap();
    const home = await snap.onHomePage();
    const ui = home.getInterface();
    await ui.typeInField('amount', '0.25');
    await ui.clickElement('make-link');
    expect(text(home.getInterface().content)).toContain('a=0.25');
  });

  it('rejects unknown methods', async () => {
    const { request } = await installSnap();
    const res = await request({ method: 'exportKeys' });
    expect(res).toRespondWithError(expect.objectContaining({ code: -32601 }));
  });
});
