/**
 * Withdraw planning: amounts, gas and the receive-side safety checks (Kohaku issue #324, H1 to H5).
 * Pure functions, no network. index.tsx feeds them chain data and signs inside the snap.
 */
export const ERC20_TRANSFER = 'a9059cbb';
export const ERC20_BALANCE_OF = '70a08231';
export const ERC20_DECIMALS = '313ce567';
export const ETH_TRANSFER_GAS = 21_000n;
export const TOKEN_TRANSFER_GAS_FALLBACK = 65_000n;
export const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
};

const pad32 = (h: string) => h.replace(/^0x/iu, '').toLowerCase().padStart(64, '0');
export const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/u.test(String(a ?? '').trim());

export function encodeTransfer(to: string, amount: bigint) {
  return `0x${ERC20_TRANSFER}${pad32(to)}${pad32(amount.toString(16))}`;
}
export function encodeBalanceOf(owner: string) {
  return `0x${ERC20_BALANCE_OF}${pad32(owner)}`;
}

/** One gas price for both fee fields: the effective price is exactly this, so an ETH sweep leaves no dust. */
export function pickGasPrice(baseFee: bigint, priority: bigint) {
  const tip = priority > 0n ? priority : 10n ** 8n; // 0.1 gwei floor
  return (baseFee * 5n) / 4n + tip; // 25% headroom over the current base fee, standard tip (H4: no custom fingerprint)
}

export type Check = { level: 'block' | 'warn'; code: string; text: string };

export function safetyChecks(p: {
  to: string;
  payer: string | null; // Announcer caller / payer of this payment
  ownStealthAddresses: string[];
  pastDestinations: string[];
  receivedSecondsAgo: number | null;
}): Check[] {
  const to = p.to.toLowerCase();
  const out: Check[] = [];
  if (p.payer && to === p.payer.toLowerCase()) out.push({ level: 'block', code: 'H2', text: 'This is the address that paid you. Sending back links the payment to you.' });
  if (p.ownStealthAddresses.some((a) => a.toLowerCase() === to)) out.push({ level: 'block', code: 'H3', text: 'This is another of your one-time addresses. Collecting them in one place links them.' });
  if (p.pastDestinations.some((a) => a.toLowerCase() === to)) out.push({ level: 'warn', code: 'H3', text: 'You already withdrew to this address. Each reuse links more payments together.' });
  if (p.receivedSecondsAgo !== null && p.receivedSecondsAgo < 3600) out.push({ level: 'warn', code: 'T1', text: 'Received less than an hour ago. Waiting longer makes timing links weaker.' });
  out.push({ level: 'warn', code: 'H1', text: 'Do not withdraw to your main wallet or any wallet people know is yours.' });
  return out;
}

export type Plan =
  | { ok: true; kind: 'eth'; value: bigint; gasLimit: bigint; gasPrice: bigint; fee: bigint; data: '0x'; txTo: string }
  | { ok: true; kind: 'token'; token: string; amount: bigint; gasLimit: bigint; gasPrice: bigint; fee: bigint; data: string; txTo: string; value: 0n }
  | { ok: false; reason: string; needWei?: bigint };

export function planEth(balanceWei: bigint, gasPrice: bigint, gasLimit = ETH_TRANSFER_GAS): Plan {
  const fee = gasLimit * gasPrice;
  if (balanceWei <= fee) return { ok: false, reason: 'Not enough ETH on this address to pay the network fee.', needWei: fee - balanceWei };
  return { ok: true, kind: 'eth', value: balanceWei - fee, gasLimit, gasPrice, fee, data: '0x', txTo: '' };
}

export function planToken(token: string, to: string, tokenBalance: bigint, ethBalance: bigint, gasPrice: bigint, gasLimit = TOKEN_TRANSFER_GAS_FALLBACK): Plan {
  if (tokenBalance <= 0n) return { ok: false, reason: 'No token balance on this address.' };
  const fee = gasLimit * gasPrice;
  if (ethBalance < fee) {
    return {
      ok: false,
      needWei: fee - ethBalance,
      reason: 'This address has no ETH for the network fee. Do not top it up from a wallet linked to you (H5). Send the fee from a fresh wallet or another exchange withdrawal, then try again.',
    };
  }
  return { ok: true, kind: 'token', token, amount: tokenBalance, gasLimit, gasPrice, fee, data: encodeTransfer(to, tokenBalance), txTo: token, value: 0n };
}

export function formatUnits(v: bigint, decimals: number, maxFrac = 6) {
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/u, '');
  return `${whole}${frac ? `.${frac}` : ''}`;
}
