# Clearstone Fusion

Permissionless, maker-scoped intent settlement on Solana.

Clearstone Fusion is a fork of [1inch `solana-fusion-protocol`](https://github.com/1inch/solana-fusion-protocol) that keeps the Dutch-auction intent-settlement design but replaces the global resolver whitelist with a **per-order, maker-signed resolver policy**. The maker's signature binds the policy via `order_hash`, so takers cannot substitute a different policy at fill time — the escrow PDA would not derive.

This is a **single-chain (Solana → Solana)** protocol. It contains no cross-chain atomic-swap primitives (no hashlocks, finality locks, public rescue windows, or dst-side escrows). See [todos.md](todos.md) for the full fork spec.

## What changed vs. upstream

- Global on-chain resolver whitelist (separate program) → per-order `ResolverPolicy` enum on `OrderConfig`.
- `ResolverPolicy` variants:
  - `AllowedList(Vec<Pubkey>)` — inline list of permitted resolvers, up to 16 entries. An empty list is permissionless (any taker). This is the default.
  - `MerkleRoot([u8; 32])` — keccak256 Merkle root (OZ-style sorted pairs) for larger curated sets. The `fill` / `cancel_by_resolver` instructions take a `merkle_proof: Option<Vec<[u8;32]>>` argument.
- `whitelist` program removed.
- Strict input validation: passing a merkle proof to an `AllowedList` order reverts with `UnexpectedMerkleProof`.
- New program ID, new crate name (`clearstone-fusion`).

Everything else (Dutch-auction math, fee split, partial fills, native-SOL wrap, cancellation-premium curve, escrow PDA seeds) is unchanged from upstream.

## Layout

- `programs/clearstone-fusion/` — Anchor program
  - `src/lib.rs` — instructions, `OrderConfig`, `ResolverPolicy`, `order_hash`
  - `src/merkle.rs` — keccak256 sorted-pair verifier + unit tests
  - `src/auction.rs`, `src/error.rs`
- `scripts/clearstone-fusion/` — driver scripts (create / fill / cancel)
- `tests/suits/` — integration tests
  - `resolver-policy.ts` — per-policy coverage (AllowedList, MerkleRoot, bounds, regression)
  - `fusion-swap.ts`, `cancel-by-resolver.ts`, `dutch-auction.ts` — upstream tests, migrated
- `ts-common/`, `scripts/utils.ts` — shared TS types + borsh schema
- `tests/utils/merkle.ts` — TS merkle-tree builder matching the on-chain verifier

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

A dev keypair is generated at `target/deploy/clearstone_fusion-keypair.json` on first build. This is **dev-only** — generate a fresh keypair for any shared / mainnet deployment and update `declare_id!` + `Anchor.toml` accordingly (`anchor keys sync`).

## License & attribution

Licensed under the MIT License. See [LICENSE.md](LICENSE.md).

This repository is a fork of [1inch `solana-fusion-protocol`](https://github.com/1inch/solana-fusion-protocol) (MIT). The original 1inch copyright notice is retained alongside Clearstone's copyright for modifications.

The names **"1inch"** and **"Fusion"** are trademarks of their respective owners and are **not licensed** by the MIT source license — Clearstone Fusion does not use these names in its branding, logos, domain, or user-facing copy.

MIT provides no patent grant. If you are deploying this commercially, an IP review of public DEX-auction patents is prudent. Not legal advice.

## Status

Pre-audit. **An external audit is required before any mainnet deployment.**
