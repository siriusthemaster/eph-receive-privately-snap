import { describe, expect, it } from '@jest/globals';
import { installSnap } from '@metamask/snaps-jest';

import { ANNOUNCEMENT_TOPIC, encodeAnnouncementData, generateStealthAddress } from './stealth';
import { decodeSignedTx1559 } from './tx';
import { encodeTransfer, pickGasPrice, planEth, planToken, safetyChecks } from './withdraw';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const PAYER = `0x${'ab'.repeat(20)}`;
const DEST = '0x3333333333333333333333333333333333333333';
const text = (x: unknown) => JSON.stringify(x).toLowerCase();

describe('withdraw planning (pure)', () => {
  it('ETH sweep leaves no dust: value + gas*price == balance', () => {
    const gp = pickGasPrice(10n ** 10n, 10n ** 9n);
    const p = planEth(10n ** 15n, gp);
    expect(p.ok).toBe(true);
    if (p.ok && p.kind === 'eth') expect(p.value + 21000n * gp).toBe(10n ** 15n);
  });
  it('refuses when ETH cannot cover the fee', () => {
    const p = planEth(1000n, 10n ** 9n);
    expect(p.ok).toBe(false);
  });
  it('token withdrawal needs ETH for gas and never suggests a linked top up', () => {
    const p = planToken(USDC, DEST, 25_000_000n, 0n, 10n ** 9n);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain('H5');
    const q = planToken(USDC, DEST, 25_000_000n, 10n ** 15n, 10n ** 9n);
    expect(q.ok && q.kind === 'token' && q.data).toBe(encodeTransfer(DEST, 25_000_000n));
  });
  it('safety checks: payer and own addresses are blocked, reuse and fresh funds warn', () => {
    const c = safetyChecks({ to: PAYER, payer: PAYER, ownStealthAddresses: [], pastDestinations: [], receivedSecondsAgo: 60 });
    expect(c.find((x) => x.code === 'H2')?.level).toBe('block');
    expect(c.find((x) => x.code === 'T1')?.level).toBe('warn');
    const d = safetyChecks({ to: DEST, payer: PAYER, ownStealthAddresses: [DEST], pastDestinations: [DEST], receivedSecondsAgo: 99999 });
    expect(d.filter((x) => x.code === 'H3').map((x) => x.level).sort()).toEqual(['block', 'warn']);
  });
});

async function setup(opts: { token?: boolean; ethWei: bigint; tokenUnits?: bigint }) {
  const snap = await installSnap();
  const metaRes: any = snap.request({ method: 'getMetaAddress', origin: 'https://eph.money' });
  const ui: any = await metaRes.getInterface();
  await ui.ok();
  const meta = String((await metaRes).response.result.metaAddress).replace('st:eth:', '');
  const s = generateStealthAddress(meta);
  const tag = s.viewTag.toString(16).padStart(2, '0');
  const md = opts.token ? `0x${tag}a9059cbb${USDC.slice(2)}${(opts.tokenUnits ?? 0n).toString(16).padStart(64, '0')}` : `0x${tag}eeeeeeee${'ee'.repeat(20)}${'0'.repeat(64)}`;
  const log = {
    address: '0x55649E01B5Df198D18D95b5cc5051630cfD45564',
    topics: [ANNOUNCEMENT_TOPIC, `0x${'0'.repeat(63)}1`, `0x${'0'.repeat(24)}${s.stealthAddress.slice(2).toLowerCase()}`, `0x${'0'.repeat(24)}${PAYER.slice(2)}`],
    data: encodeAnnouncementData(s.ephemeralPublicKey, md),
    blockNumber: '0x1406f9c', // 21000092
    transactionHash: `0x${'cd'.repeat(32)}`,
  };
  const sent: string[] = [];
  snap.mockJsonRpc((req: any) => {
    switch (req.method) {
      case 'eth_chainId': return '0x1';
      case 'eth_blockNumber': return '0x1408e80';
      case 'eth_getLogs': {
        const b = 21000092;
        return parseInt(req.params[0].fromBlock, 16) <= b && b <= parseInt(req.params[0].toBlock, 16) ? [log] : [];
      }
      case 'eth_getBalance': return req.params[0].toLowerCase() === s.stealthAddress.toLowerCase() ? `0x${opts.ethWei.toString(16)}` : '0x0';
      case 'eth_call': return `0x${(opts.tokenUnits ?? 0n).toString(16).padStart(64, '0')}`;
      case 'eth_getBlockByNumber': return req.params[0] === 'latest' ? { baseFeePerGas: '0x2540be400', timestamp: '0x6740000' } : { timestamp: '0x6700000' }; // base fee 10 gwei, received long ago
      case 'eth_maxPriorityFeePerGas': return '0x3b9aca00'; // 1 gwei
      case 'eth_getTransactionByHash': return { from: PAYER };
      case 'eth_getCode': return '0x';
      case 'eth_estimateGas': return '0xfde8'; // 65000
      case 'eth_getTransactionCount': return '0x0';
      case 'eth_sendRawTransaction': sent.push(req.params[0]); return `0x${'ef'.repeat(32)}`;
      default: return undefined;
    }
  });
  const home = await snap.onHomePage();
  await home.getInterface().clickElement('scan');
  return { snap, home, s, sent };
}

describe('withdraw in the snap (simulation)', () => {
  it('ETH: review, confirm, signs inside the snap from the one-time address, full sweep', async () => {
    const { home, s, sent } = await setup({ ethWei: 10n ** 15n });
    expect(text(home.getInterface().content)).toContain('withdraw');
    await home.getInterface().clickElement('wd-0');
    let ui = home.getInterface();
    await ui.typeInField('to', DEST);
    await ui.selectInDropdown('asset', 'eth');
    await ui.clickElement('wd-review');
    ui = home.getInterface();
    expect(text(ui.content)).toContain('review withdrawal');
    expect(text(ui.content)).not.toContain('blocked');
    await ui.clickElement('wd-confirm');
    expect(text(home.getInterface().content)).toContain('etherscan.io/tx/0xefef');
    expect(sent).toHaveLength(1);
    const { tx, from } = decodeSignedTx1559(sent[0] as string);
    const gp = pickGasPrice(10n ** 10n, 10n ** 9n);
    expect(from).toBe(s.stealthAddress.toLowerCase());
    expect(tx.to).toBe(DEST);
    expect(tx.value + 21000n * gp).toBe(10n ** 15n);
    expect(tx.maxFeePerGas).toBe(gp);
    expect(tx.chainId).toBe(1n);
    // the dapp-facing API still cannot reach any key or withdrawal
  });

  it('blocks sending back to the payer (H2) and sends nothing', async () => {
    const { home, sent } = await setup({ ethWei: 10n ** 15n });
    await home.getInterface().clickElement('wd-0');
    const ui = home.getInterface();
    await ui.typeInField('to', PAYER);
    await ui.clickElement('wd-review');
    const t = text(home.getInterface().content);
    expect(t).toContain('blocked (h2)');
    expect(t).not.toContain('wd-confirm');
    expect(sent).toHaveLength(0);
  });

  it('USDC without ETH for gas: explains H5 and sends nothing; with gas: ERC-20 transfer of the full balance', async () => {
    const noGas = await setup({ token: true, ethWei: 0n, tokenUnits: 25_000_000n });
    expect(text(noGas.home.getInterface().content)).toContain('25 usdc');
    await noGas.home.getInterface().clickElement('wd-0');
    let ui = noGas.home.getInterface();
    await ui.typeInField('to', DEST);
    await ui.selectInDropdown('asset', 'token');
    await ui.clickElement('wd-review');
    expect(text(noGas.home.getInterface().content)).toContain('h5');
    expect(noGas.sent).toHaveLength(0);

    const withGas = await setup({ token: true, ethWei: 10n ** 16n, tokenUnits: 25_000_000n });
    await withGas.home.getInterface().clickElement('wd-0');
    ui = withGas.home.getInterface();
    await ui.typeInField('to', DEST);
    await ui.selectInDropdown('asset', 'token');
    await ui.clickElement('wd-review');
    await withGas.home.getInterface().clickElement('wd-confirm');
    expect(withGas.sent).toHaveLength(1);
    const { tx, from } = decodeSignedTx1559(withGas.sent[0] as string);
    expect(from).toBe(withGas.s.stealthAddress.toLowerCase());
    expect(tx.to).toBe(USDC);
    expect(tx.value).toBe(0n);
    expect(tx.data).toBe(encodeTransfer(DEST, 25_000_000n));
    expect(tx.gasLimit).toBe(78_000n); // 65000 estimate + 20%
  });

  it('rejects an invalid destination', async () => {
    const { home, sent } = await setup({ ethWei: 10n ** 15n });
    await home.getInterface().clickElement('wd-0');
    const ui = home.getInterface();
    await ui.typeInField('to', '0x1234');
    await ui.clickElement('wd-review');
    expect(text(home.getInterface().content)).toContain('valid 0x address');
    expect(sent).toHaveLength(0);
  });
});
