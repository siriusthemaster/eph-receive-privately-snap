# Notice: code origin

The ERC-5564 scheme 1 math in `src/stealth.ts` was ported from ephemeral.money's own sender and tip code (`shared/stealth.js` and `shared/stealth-tips.js` in the private eph repository), written by the same author (Sirius). Only the generic, standard math was copied:

- meta-address parse and encode (`st:eth:0x` + compressed spend key + compressed view key)
- one-time address generation: shared secret, view tag, P_stealth = P_spend + hash(shared) * G
- announcement check with the view key and view tag, stealth private key = spend key + hash(shared) mod n
- Announcer log decoding and `announce` calldata encoding

All of this follows the public ERC-5564 specification and is checked against the ScopeLift worked example vector in the tests. No server code, API keys, URLs of non-public environments, business logic or other private eph code is included.

New in this repository (not from eph): key derivation from `snap_getEntropy`, the snap UI and handlers (`src/index.tsx`), EIP-1559 signing (`src/tx.ts`) and the withdrawal planning and safety checks (`src/withdraw.ts`).

Libraries: @noble/curves and @noble/hashes (MIT), @metamask/snaps-sdk (MIT OR Apache-2.0).
