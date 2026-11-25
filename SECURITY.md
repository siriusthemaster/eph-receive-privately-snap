# Security

- Keys are derived inside the snap from `snap_getEntropy` and never leave it. A one-time key is derived only when the user confirms a withdrawal on the review screen, used to sign that single transaction, and wiped.
- Dapps can only call `getMetaAddress` and `getPayLink`, each behind a user confirmation. No dapp can read found payments or start a withdrawal.
- Withdrawals are signed for Ethereum mainnet (chain id 1) only and sent with `eth_sendRawTransaction` through MetaMask's provider.
- This snap has not had a third-party audit yet. Please report issues privately via GitHub security advisories on this repository.

## Reporting a vulnerability
Please do not open a public issue. Use GitHub's private vulnerability reporting: the "Security" tab of https://github.com/siriusthemaster/eph-receive-privately-snap, then "Report a vulnerability". We aim to acknowledge reports within 72 hours.

## Supported versions
Only the latest published version receives security fixes.
