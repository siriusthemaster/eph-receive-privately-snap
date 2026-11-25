# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

### Added
- Initial release: ERC-5564 (scheme 1) private receive address, pay links, payment scanning through the canonical Announcer, and withdrawals of ETH and ERC-20 tokens from one-time addresses.
- Pre-withdrawal safety checks (no sending back to the payer, no sending to own one-time addresses, warnings for reused destinations and recent receipts).
- Tests: snaps-jest simulations, ScopeLift test vector, real mainnet Announcer logs, viem cross-checks of signed transactions.

[Unreleased]: https://github.com/siriusthemaster/eph-receive-privately-snap/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/siriusthemaster/eph-receive-privately-snap/releases/tag/v0.1.0
