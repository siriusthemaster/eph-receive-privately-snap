import type {
  OnHomePageHandler,
  OnInstallHandler,
  OnRpcRequestHandler,
  OnUserInputHandler,
} from '@metamask/snaps-sdk';
import { MethodNotFoundError, UserInputEventType, UserRejectedRequestError } from '@metamask/snaps-sdk';
import {
  Address,
  Banner,
  Box,
  Button,
  Copyable,
  Divider,
  Dropdown,
  Field,
  Form,
  Heading,
  Input,
  Link,
  Option,
  Row,
  Section,
  Text,
} from '@metamask/snaps-sdk/jsx';

import {
  ANNOUNCER,
  ANNOUNCEMENT_TOPIC,
  HONESTY,
  SCHEME_TOPIC,
  checkAnnouncement,
  decodeAnnouncementLog,
  keysFromEntropy,
  metaUri,
  payLink,
  pointToAddress,
  stealthPrivateKey,
} from './stealth';
import { secp256k1 } from '@noble/curves/secp256k1';
import { signTx1559 } from './tx';
import {
  ERC20_DECIMALS,
  ETH_TRANSFER_GAS,
  KNOWN_TOKENS,
  TOKEN_TRANSFER_GAS_FALLBACK,
  encodeBalanceOf,
  formatUnits,
  isAddress,
  pickGasPrice,
  planEth,
  planToken,
  safetyChecks,
} from './withdraw';
import type { Check } from './withdraw';

const ENTROPY_SALT = 'eph-receive-privately-v1';
export const INITIAL_LOOKBACK = 50_000; // blocks scanned on first run (about 7 days on Ethereum)
export const CHUNK = 5_000;
export const MAX_CHUNKS_PER_SCAN = 20;

type Found = {
  stealthAddress: string;
  ephemeralPublicKey: string;
  token: string | null;
  blockNumber: number;
  txHash: string;
  caller?: string;
  balanceWei?: string;
  tokenBalance?: string;
  tokenDecimals?: number;
  tokenSymbol?: string;
  withdrawn?: string[]; // tx hashes
};
type Pending = {
  index: number;
  to?: string;
  asset?: string;
  review?: { kind: 'eth' | 'token'; txTo: string; value: string; data: string; gasLimit: string; gasPrice: string; fee: string; amountText: string; checks: Check[] };
};
type State = { lastBlock: number | null; found: Found[]; link?: string; destinations?: string[]; pending?: Pending | null };

async function getKeys() {
  const entropy = await snap.request({ method: 'snap_getEntropy', params: { version: 1, salt: ENTROPY_SALT } });
  return keysFromEntropy(entropy);
}

async function getState(): Promise<State> {
  const s = (await snap.request({ method: 'snap_manageState', params: { operation: 'get', encrypted: true } })) as State | null;
  return s ?? { lastBlock: null, found: [] };
}
async function setState(s: State) {
  await snap.request({ method: 'snap_manageState', params: { operation: 'update', newState: s as any, encrypted: true } });
}

const rpc = async (method: string, params: unknown[] = []) => ethereum.request({ method, params } as any) as Promise<any>;

export function formatEth(wei: string | bigint) {
  const w = BigInt(wei);
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/u, '');
  return `${whole}${frac ? `.${frac}` : ''} ETH`;
}

/** Scan new ERC-5564 announcements, keep the ones that are ours, refresh balances. */
export async function scan() {
  const keys = await getKeys();
  const state = await getState();
  const head = parseInt(await rpc('eth_blockNumber'), 16);
  let from = state.lastBlock === null ? Math.max(0, head - INITIAL_LOOKBACK) : state.lastBlock + 1;
  let chunks = 0;
  let checked = 0;
  while (from <= head && chunks < MAX_CHUNKS_PER_SCAN) {
    const to = Math.min(head, from + CHUNK - 1);
    const logs: any[] = await rpc('eth_getLogs', [
      { address: ANNOUNCER, topics: [ANNOUNCEMENT_TOPIC, SCHEME_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` },
    ]);
    for (const log of logs ?? []) {
      const a = decodeAnnouncementLog(log);
      if (!a) continue;
      checked += 1;
      const mine = checkAnnouncement(keys, a.ephemeralPublicKey, a.viewTag, a.stealthAddress);
      if (mine && !state.found.some((f) => f.stealthAddress.toLowerCase() === mine.toLowerCase())) {
        state.found.push({ stealthAddress: mine, ephemeralPublicKey: a.ephemeralPublicKey, token: a.token, blockNumber: a.blockNumber, txHash: a.txHash, caller: a.caller });
      }
    }
    state.lastBlock = to;
    from = to + 1;
    chunks += 1;
  }
  for (const f of state.found) await refreshBalances(f);
  await setState(state);
  return { checked, found: state.found.length, upToBlock: state.lastBlock, head, done: (state.lastBlock ?? 0) >= head };
}

async function refreshBalances(f: Found) {
  try {
    f.balanceWei = BigInt(await rpc('eth_getBalance', [f.stealthAddress, 'latest'])).toString();
  } catch {
    /* keep the previous balance */
  }
  if (f.token) {
    try {
      f.tokenBalance = BigInt(await rpc('eth_call', [{ to: f.token, data: encodeBalanceOf(f.stealthAddress) }, 'latest'])).toString();
      const known = KNOWN_TOKENS[f.token.toLowerCase()];
      if (known) {
        f.tokenDecimals = known.decimals;
        f.tokenSymbol = known.symbol;
      } else if (f.tokenDecimals === undefined) {
        f.tokenDecimals = Number(BigInt(await rpc('eth_call', [{ to: f.token, data: `0x${ERC20_DECIMALS}` }, 'latest'])));
        f.tokenSymbol = 'tokens';
      }
    } catch {
      /* keep the previous balance */
    }
  }
}

function rowLabel(f: Found) {
  const eth = formatEth(f.balanceWei ?? '0');
  if (!f.token) return eth;
  return `${formatUnits(BigInt(f.tokenBalance ?? '0'), f.tokenDecimals ?? 18)} ${f.tokenSymbol ?? 'tokens'} + ${eth}`;
}

function withdrawUi(f: Found, p: Pending, msg?: string) {
  const hasToken = Boolean(f.token);
  const options = [<Option value="eth">All ETH (minus network fee)</Option>];
  if (hasToken) options.push(<Option value="token">{`All ${f.tokenSymbol ?? 'tokens'}`}</Option>);
  return (
    <Box>
      <Heading>Withdraw</Heading>
      <Row label="From one-time address">
        <Address address={f.stealthAddress as `0x${string}`} />
      </Row>
      <Text>Balance: {rowLabel(f)}</Text>
      <Form name="wd-form">
        <Field label="Send to (a fresh wallet that is not linked to you)">
          <Input name="to" placeholder="0x..." value={p.to ?? ''} />
        </Field>
        <Field label="What to send">
          <Dropdown name="asset" value={p.asset ?? (hasToken ? 'token' : 'eth')}>
            {options}
          </Dropdown>
        </Field>
        <Button type="submit" name="wd-review">Review</Button>
      </Form>
      {msg ? <Banner title="Cannot continue" severity="warning"><Text>{msg}</Text></Banner> : null}
      <Button name="wd-back">Back</Button>
    </Box>
  );
}

function reviewUi(f: Found, p: Pending) {
  const r = p.review!;
  const blocked = r.checks.some((c) => c.level === 'block');
  return (
    <Box>
      <Heading>Review withdrawal</Heading>
      <Row label="From">
        <Address address={f.stealthAddress as `0x${string}`} />
      </Row>
      <Row label="To">
        <Address address={p.to as `0x${string}`} />
      </Row>
      <Row label="Amount">
        <Text>{r.amountText}</Text>
      </Row>
      <Row label="Network fee (max)">
        <Text>{formatEth(r.fee)}</Text>
      </Row>
      {r.checks.map((c) => (
        <Banner title={c.level === 'block' ? `Blocked (${c.code})` : `Check (${c.code})`} severity={c.level === 'block' ? 'danger' : 'warning'}>
          <Text>{c.text}</Text>
        </Banner>
      ))}
      {blocked ? <Text>Choose another destination.</Text> : <Button name="wd-confirm">Confirm and send</Button>}
      <Button name="wd-edit">Change</Button>
    </Box>
  );
}

function sentUi(f: Found, hash: string) {
  return (
    <Box>
      <Heading>Sent</Heading>
      <Text>Withdrawal submitted from {f.stealthAddress.slice(0, 8)}...</Text>
      <Copyable value={hash} />
      <Link href={`https://etherscan.io/tx/${hash}`}>View on Etherscan</Link>
      <Button name="wd-back">Back</Button>
    </Box>
  );
}

async function gasPriceNow() {
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  let prio = 10n ** 9n;
  try {
    prio = BigInt(await rpc('eth_maxPriorityFeePerGas'));
  } catch {
    /* fallback 1 gwei */
  }
  return { gasPrice: pickGasPrice(BigInt(block?.baseFeePerGas ?? '0x0'), prio), now: Number(BigInt(block?.timestamp ?? '0x0')) };
}

async function buildReview(state: State, f: Found, p: Pending): Promise<string | null> {
  const to = String(p.to ?? '').trim();
  if (!isAddress(to)) return 'Enter a valid 0x address.';
  await refreshBalances(f);
  const { gasPrice, now } = await gasPriceNow();
  let payer: string | null = f.caller ?? null;
  let payerTx: string | null = null;
  let receivedSecondsAgo: number | null = null;
  try {
    const t = await rpc('eth_getTransactionByHash', [f.txHash]);
    payerTx = t?.from ?? null;
  } catch {
    /* unknown */
  }
  try {
    const b = await rpc('eth_getBlockByNumber', [`0x${f.blockNumber.toString(16)}`, false]);
    if (b?.timestamp && now) receivedSecondsAgo = now - Number(BigInt(b.timestamp));
  } catch {
    /* unknown */
  }
  const checks = safetyChecks({
    to,
    payer,
    ownStealthAddresses: state.found.map((x) => x.stealthAddress),
    pastDestinations: state.destinations ?? [],
    receivedSecondsAgo,
  });
  if (payerTx && payerTx.toLowerCase() === to.toLowerCase() && !checks.some((c) => c.code === 'H2')) {
    checks.unshift({ level: 'block', code: 'H2', text: 'This is the wallet that sent the payment. Sending back links the payment to you.' });
  }
  const eth = BigInt(f.balanceWei ?? '0');
  if ((p.asset ?? 'eth') === 'token' && f.token) {
    let gasLimit = TOKEN_TRANSFER_GAS_FALLBACK;
    const bal = BigInt(f.tokenBalance ?? '0');
    try {
      const est = BigInt(await rpc('eth_estimateGas', [{ from: f.stealthAddress, to: f.token, data: `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, '0')}${bal.toString(16).padStart(64, '0')}` }]));
      gasLimit = (est * 6n) / 5n;
    } catch {
      /* fallback */
    }
    const plan = planToken(f.token, to, bal, eth, gasPrice, gasLimit);
    if (!plan.ok) return plan.needWei ? `${plan.reason} Needed: ${formatEth(plan.needWei)}.` : plan.reason;
    if (plan.kind !== 'token') return 'Unexpected plan.';
    p.review = { kind: 'token', txTo: plan.txTo, value: '0', data: plan.data, gasLimit: plan.gasLimit.toString(), gasPrice: gasPrice.toString(), fee: plan.fee.toString(), amountText: `${formatUnits(bal, f.tokenDecimals ?? 18)} ${f.tokenSymbol ?? 'tokens'}`, checks };
    return null;
  }
  let gasLimit = ETH_TRANSFER_GAS;
  try {
    const code = await rpc('eth_getCode', [to, 'latest']);
    if (code && code !== '0x') gasLimit = (BigInt(await rpc('eth_estimateGas', [{ from: f.stealthAddress, to, value: '0x1' }])) * 6n) / 5n;
  } catch {
    /* plain address */
  }
  const plan = planEth(eth, gasPrice, gasLimit);
  if (!plan.ok) return plan.needWei ? `${plan.reason} Needed: ${formatEth(plan.needWei)} more.` : plan.reason;
  if (plan.kind !== 'eth') return 'Unexpected plan.';
  p.review = { kind: 'eth', txTo: to, value: plan.value.toString(), data: '0x', gasLimit: plan.gasLimit.toString(), gasPrice: gasPrice.toString(), fee: plan.fee.toString(), amountText: formatEth(plan.value), checks };
  return null;
}

/** Derive the one-time key, check it controls the address, sign and broadcast. The key never leaves this function. */
async function sendWithdrawal(f: Found, p: Pending) {
  const r = p.review!;
  if (r.checks.some((c) => c.level === 'block')) throw new Error('Blocked by a safety check.');
  const chainId = BigInt(await rpc('eth_chainId'));
  if (chainId !== 1n) throw new Error('Switch MetaMask to Ethereum mainnet.');
  const nonce = BigInt(await rpc('eth_getTransactionCount', [f.stealthAddress, 'pending']));
  const gasPrice = BigInt(r.gasPrice);
  const keys = await getKeys();
  const priv = stealthPrivateKey(keys, f.ephemeralPublicKey);
  let raw: string;
  try {
    const addr = pointToAddress(secp256k1.ProjectivePoint.fromHex(secp256k1.getPublicKey(priv, false)));
    if (addr.toLowerCase() !== f.stealthAddress.toLowerCase()) throw new Error('Key check failed, nothing was sent.');
    raw = signTx1559({ chainId, nonce, maxPriorityFeePerGas: gasPrice, maxFeePerGas: gasPrice, gasLimit: BigInt(r.gasLimit), to: r.txTo, value: BigInt(r.value), data: r.data }, priv);
  } finally {
    priv.fill(0);
  }
  return (await rpc('eth_sendRawTransaction', [raw])) as string;
}

function homeUi(meta: string, state: State, note?: string) {
  return (
    <Box>
      <Heading>Receive privately</Heading>
      <Text>Share this once. Every payment lands on a fresh one-time address that only you can open.</Text>
      <Section>
        <Text>Your private receive address (ERC-5564)</Text>
        <Copyable value={metaUri(meta)} />
      </Section>
      <Form name="link-form">
        <Field label="Amount in ETH (optional)">
          <Input name="amount" placeholder="0.05" />
        </Field>
        <Field label="Note (optional)">
          <Input name="note" placeholder="Invoice 12" />
        </Field>
        <Button type="submit" name="make-link">Create pay link</Button>
      </Form>
      {state.link ? (
        <Section>
          <Text>Pay link</Text>
          <Copyable value={state.link} />
        </Section>
      ) : null}
      <Divider />
      <Button name="scan">Scan for payments</Button>
      {note ? <Text>{note}</Text> : null}
      {state.found.length === 0 ? (
        <Text>No payments found yet.</Text>
      ) : (
        <Box>
          {state.found.map((f, i) => (
            <Box>
              <Row label={rowLabel(f)}>
                <Address address={f.stealthAddress as `0x${string}`} />
              </Row>
              <Button name={`wd-${i}`}>Withdraw</Button>
            </Box>
          ))}
        </Box>
      )}
      <Banner title="What this hides" severity="info">
        <Text>{HONESTY}</Text>
      </Banner>
    </Box>
  );
}

export const onHomePage: OnHomePageHandler = async () => {
  const keys = await getKeys();
  const state = await getState();
  return { content: homeUi(keys.meta, state) };
};

export const onUserInput: OnUserInputHandler = async ({ id, event }) => {
  const keys = await getKeys();
  const show = async (ui: any) => snap.request({ method: 'snap_updateInterface', params: { id, ui } });
  if (event.type === UserInputEventType.ButtonClickEvent && event.name?.startsWith('wd')) {
    const state = await getState();
    const name = event.name;
    if (/^wd-\d+$/u.test(name)) {
      const index = Number(name.slice(3));
      const f = state.found[index];
      if (!f) return;
      state.pending = { index };
      await refreshBalances(f);
      await setState(state);
      await show(withdrawUi(f, state.pending));
      return;
    }
    const p = state.pending;
    const f = p ? state.found[p.index] : undefined;
    if (name === 'wd-back' || !p || !f) {
      state.pending = null;
      await setState(state);
      await show(homeUi(keys.meta, state));
      return;
    }
    if (name === 'wd-edit') {
      await show(withdrawUi(f, p));
      return;
    }
    if (name === 'wd-confirm' && p.review) {
      try {
        const hash = await sendWithdrawal(f, p);
        f.withdrawn = [...(f.withdrawn ?? []), hash];
        state.destinations = [...(state.destinations ?? []), String(p.to)];
        state.pending = null;
        await setState(state);
        await show(sentUi(f, hash));
      } catch (e) {
        await show(withdrawUi(f, p, (e as Error).message));
      }
      return;
    }
  }
  if (event.type === UserInputEventType.FormSubmitEvent && event.name === 'wd-form') {
    const state = await getState();
    const p = state.pending;
    const f = p ? state.found[p.index] : undefined;
    if (!p || !f) return;
    const v = (event.value ?? {}) as { to?: string; asset?: string };
    p.to = String(v.to ?? '').trim();
    p.asset = String(v.asset ?? (f.token ? 'token' : 'eth'));
    p.review = undefined;
    let err: string | null;
    try {
      err = await buildReview(state, f, p);
    } catch (e) {
      err = `Could not prepare: ${(e as Error).message}`;
    }
    await setState(state);
    await show(err ? withdrawUi(f, p, err) : reviewUi(f, p));
    return;
  }
  if (event.type === UserInputEventType.ButtonClickEvent && event.name === 'scan') {
    let note: string;
    try {
      const r = await scan();
      note = `Checked ${r.checked} announcements up to block ${r.upToBlock}.${r.done ? '' : ' More blocks left, press Scan again.'}`;
    } catch (e) {
      note = `Scan failed: ${(e as Error).message}`;
    }
    await snap.request({ method: 'snap_updateInterface', params: { id, ui: homeUi(keys.meta, await getState(), note) } });
    return;
  }
  if (event.type === UserInputEventType.FormSubmitEvent && event.name === 'link-form') {
    const v = (event.value ?? {}) as { amount?: string; note?: string };
    const amount = String(v.amount ?? '').trim();
    const state = await getState();
    let note: string | undefined;
    if (amount && !/^\d{1,6}(\.\d{1,18})?$/u.test(amount)) {
      note = 'Amount must be a number like 0.05';
    } else {
      state.link = payLink(keys.meta, { amount: amount || undefined, note: String(v.note ?? '').trim() || undefined });
      await setState(state);
    }
    await snap.request({ method: 'snap_updateInterface', params: { id, ui: homeUi(keys.meta, state, note) } });
  }
};

export const onInstall: OnInstallHandler = async () => {
  await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'alert',
      content: (
        <Box>
          <Heading>Receive privately is ready</Heading>
          <Text>Open it from the Snaps menu to copy your private receive address or a pay link.</Text>
          <Text>{HONESTY}</Text>
          <Text>Prototype. Your keys come from your MetaMask Secret Recovery Phrase. Withdrawals are signed inside this snap after you review them.</Text>
        </Box>
      ),
    },
  });
};

/** Dapps can ask for the public receive address or a pay link, only after the user agrees. They never see found payments or keys. */
export const onRpcRequest: OnRpcRequestHandler = async ({ origin, request }) => {
  switch (request.method) {
    case 'getMetaAddress':
    case 'getPayLink': {
      const ok = await snap.request({
        method: 'snap_dialog',
        params: {
          type: 'confirmation',
          content: (
            <Box>
              <Heading>Share your private receive address?</Heading>
              <Text>{origin} wants your ERC-5564 receive address. It can be used to pay you, but it does not show your balance or your main wallet.</Text>
            </Box>
          ),
        },
      });
      if (!ok) throw new UserRejectedRequestError();
      const keys = await getKeys();
      if (request.method === 'getMetaAddress') return { schemeId: 1, metaAddress: metaUri(keys.meta) };
      const p = (request.params ?? {}) as { amount?: string; note?: string };
      const amount = p.amount && /^\d{1,6}(\.\d{1,18})?$/u.test(String(p.amount)) ? String(p.amount) : undefined;
      return { schemeId: 1, metaAddress: metaUri(keys.meta), link: payLink(keys.meta, { amount, note: p.note ? String(p.note) : undefined }) };
    }
    default:
      throw new MethodNotFoundError() as unknown as Error;
  }
};
