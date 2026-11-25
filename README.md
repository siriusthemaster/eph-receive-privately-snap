# Receive Privately by ephemeral

A MetaMask Snap for private receiving on Ethereum with ERC-5564 stealth addresses (scheme 1, secp256k1 with view tags).

## What it does
- Gives you one private receive address (`st:eth:0x...`). Every payment to it lands on a fresh one-time address that only you can open.
- Makes pay links (`https://eph.money/r#m=...`). The data after `#` never reaches a server.
- Scans the canonical ERC-5564 Announcer (0x55649E01B5Df198D18D95b5cc5051630cfD45564) through MetaMask's own provider and lists payments found for you, with ETH and token balances.
- Withdraws from a one-time address to an address you choose: all ETH, or the full ERC-20 balance (for example USDC). You review the network fee and safety checks first, then confirm.

## Safety checks before a withdrawal
- Sending back to the payer is blocked.
- Sending to one of your own one-time addresses is blocked.
- Reusing a destination, or withdrawing within 1 hour of receiving, shows a warning.
- A token withdrawal needs a little ETH on the same one-time address for the network fee. The snap explains this instead of suggesting a top up from a linked wallet.

## Security
Keys are derived inside the snap with `snap_getEntropy` and never leave it. Withdrawals are signed for Ethereum mainnet only. The snap has not had a third-party audit yet. See [SECURITY.md](SECURITY.md) for the model and how to report a vulnerability privately.

## Install
Use the snap from a dapp with `wallet_requestSnaps`:
```js
await ethereum.request({
  method: 'wallet_requestSnaps',
  params: { 'npm:eph-receive-privately-snap': {} },
});
```
Until the snap is listed in the MetaMask Snaps Directory it runs in MetaMask Flask only. From source:
```
git clone https://github.com/siriusthemaster/eph-receive-privately-snap.git
cd eph-receive-privately-snap
npm ci
npm run build
npm run serve   # http://localhost:8080, then install `local:http://localhost:8080` in Flask
```

## Usage
Dapps can call two RPC methods, each behind a user confirmation in MetaMask:
```js
const metaAddress = await ethereum.request({
  method: 'wallet_invokeSnap',
  params: { snapId: 'npm:eph-receive-privately-snap', request: { method: 'getMetaAddress' } },
});
const payLink = await ethereum.request({
  method: 'wallet_invokeSnap',
  params: { snapId: 'npm:eph-receive-privately-snap', request: { method: 'getPayLink' } },
});
```
Scanning for payments and withdrawals are done by the user on the snap home page in MetaMask (Snaps menu). Dapps cannot read found payments or start withdrawals.

## Develop
```
npm install
npm test        # Jest (snaps-jest simulator, incl. withdrawal simulations) + viem cross-check of signed transactions
npm run build   # dist/bundle.js, updates the manifest shasum
npm run serve   # http://localhost:8080 for MetaMask Flask
```

## Status
Version 0.1.0. Not audited yet. Works in MetaMask Flask. Listing in the MetaMask Snaps Directory requires an audit because the snap uses `snap_getEntropy`.

## Changelog
See [CHANGELOG.md](CHANGELOG.md).

## License
Dual licensed under [MIT-0](LICENSE.MIT0) or [Apache-2.0](LICENSE.APACHE2), at your option (SPDX: `(MIT-0 OR Apache-2.0)`). Code origin: see [NOTICE.md](NOTICE.md).
