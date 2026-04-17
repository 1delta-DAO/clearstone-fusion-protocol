# Clearstone Fusion

Permissionless, maker-scoped **intent settlement on Solana with no escrow**.

Clearstone Fusion is a fork of [1inch `solana-fusion-protocol`](https://github.com/1inch/solana-fusion-protocol) that preserves the Dutch-auction intent-settlement design but swaps two of its core pieces:

1. **Pre-deposit escrow → pull-on-settle.** Makers don't lock capital. They sign an order off-chain; resolvers submit the signed order together with a native Ed25519 verification, and the program pulls src tokens from the maker's wallet at fill time via an SPL Token `Approve` delegation.
2. **Global on-chain whitelist → per-order, maker-signed `ResolverPolicy`.** The maker's signature binds the policy to the order hash, so takers can't substitute a different policy at fill time.

This is a **single-chain (Solana → Solana)** protocol. No cross-chain primitives (hashlocks, finality locks, public rescue windows, dst-side escrows). See [todos.md](todos.md) for the original fork spec.

## Flow

**One-time setup** (maker):
- SPL Token `Approve(delegate = DelegatePDA, amount = N)` on the src ATA. The program's delegate PDA is derived as `PDA(program_id, ["delegate"])`. The approved amount caps how much the maker can be drawn down across all concurrent orders.

**Order creation** (maker, off-chain):
- Build an `OrderConfig` (id, amounts, expiry, fee split, Dutch auction data, resolver policy).
- Compute the canonical `order_hash` — it is sha256-domain-separated by `program_id`.
- Sign `order_hash` with Ed25519.
- Distribute `(OrderConfig, signature)` to resolvers via any off-chain channel.

**Fill** (resolver, on-chain):
- Assemble a transaction with **two** instructions:
  1. Solana's native `Ed25519Program` verify instruction carrying `(maker_pubkey, order_hash, signature)`.
  2. `fill(order, amount, merkle_proof?)`.
- The program:
  - Validates the preceding Ed25519 instruction binds the maker's pubkey to this exact order hash.
  - Enforces the order's `ResolverPolicy`.
  - Computes the Dutch-auction price for the current timestamp.
  - Signs as the delegate PDA and pulls up to `min(amount, remaining)` src tokens from the maker's ATA into the taker's ATA.
  - Has the taker pay dst tokens (+ fees) to the maker.
  - Initializes (on first fill) or updates the per-order `OrderState` PDA to track cumulative `filled_amount`.

**Cancellation**:
- Off-chain: stop broadcasting. Free, but doesn't stop resolvers with stale caches.
- On-chain: `cancel(order)` — maker-signed, writes `canceled = true` into the `OrderState` PDA. Any subsequent fill reverts with `OrderCanceled`.

**Expired-order cleanup**:
- `clean_expired(order_hash)` — permissionless after expiration. Closes the `OrderState` PDA and sends the rent to the caller.

## Resolver policy

Unchanged concept from the prior fork iteration, restated here:

- `AllowedList(Vec<Pubkey>)` — inline list, up to 16 entries. Empty = permissionless (any taker). This is the default.
- `MerkleRoot([u8; 32])` — keccak256 Merkle root (OZ-style sorted pairs) for larger curated sets. The fill instruction takes a `merkle_proof` argument (max depth 10, i.e. up to 1024 resolvers).

The policy is part of the signed `OrderConfig` and therefore hashed into `order_hash`. Mutating the policy invalidates the maker's signature — the preceding Ed25519 verify instruction cannot be reconstructed without the maker's private key.

## Trade-offs of the pull model

- ✅ **No locked capital** — makers can have many concurrent orders against the same balance.
- ✅ **Free off-chain cancellation** — revoke `Approve` or stop broadcasting.
- ✅ **Same wallet for trading and holding** — no protocol-custody step.
- ⚠️ **Resolver griefing risk** — a maker can revoke the delegation or spend the balance after signing but before the winning resolver's fill lands. The resolver eats the failed transaction fee. Expected mitigation: off-chain resolver reputation / resolver-only auctions (same model as 1inch Fusion on EVM).
- ⚠️ **Native SOL as src is unsupported** — `Approve` doesn't apply to native SOL. Sellers of SOL must wrap to wSOL before signing.

## Layout

- `programs/clearstone-fusion/src/`
  - `lib.rs` — `fill`, `cancel`, `clean_expired`, `OrderConfig`, `ResolverPolicy`, `order_hash`
  - `sig.rs` — Ed25519 preceding-instruction parser / validator
  - `state.rs` — `OrderState` account
  - `merkle.rs` — keccak256 sorted-pair verifier + unit tests
  - `auction.rs`, `error.rs`
- `tests/suits/`
  - `fill.ts` — full fill, partial fills, delegation-missing
  - `signature-cancel.ts` — Ed25519 enforcement, `cancel`, `clean_expired`
  - `resolver-policy.ts` — per-policy authorization
  - `dutch-auction.ts` — price-curve sanity
- `tests/utils/merkle.ts` — TS merkle tree builder matching the on-chain verifier
- `scripts/utils.ts` — order-hash, sign-order, approve, and PDA helpers
- `ts-common/common.ts` — shared TS types

## Build & test

```
yarn install
anchor build
yarn lint
yarn typecheck
yarn test
```

Rust-only unit tests (merkle):
```
cargo test -p clearstone-fusion --lib merkle
```

## Program keypair

A dev keypair is generated at `target/deploy/clearstone_fusion-keypair.json` on first build. This is **dev-only** — generate a fresh keypair for any shared / mainnet deployment and update `declare_id!` + `Anchor.toml` (`anchor keys sync`).

## License & attribution

Licensed under the MIT License. See [LICENSE.md](LICENSE.md).

This repository is a fork of [1inch `solana-fusion-protocol`](https://github.com/1inch/solana-fusion-protocol) (MIT). The original 1inch copyright notice is retained alongside Clearstone's copyright for modifications.

The names **"1inch"** and **"Fusion"** are trademarks of their respective owners and are **not licensed** by the MIT source license — Clearstone Fusion does not use these names in its branding, logos, domain, or user-facing copy.

MIT provides no patent grant. An IP review of public DEX-auction patents is prudent before commercial launch. Not legal advice.

## Status

Pre-audit. **An external audit is required before any mainnet deployment.** The pull model introduces a distinct threat surface (Ed25519 precompile handling, delegate-PDA authority, order-replay protection via `OrderState`) that wasn't audited in the upstream escrow design.
