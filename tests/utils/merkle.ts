import { PublicKey } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";

const LEAF_DOMAIN = new Uint8Array([0x00]);
const NODE_DOMAIN = new Uint8Array([0x01]);

function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function compare(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function hashLeaf(pubkey: PublicKey): Uint8Array {
  return keccak_256(concat(LEAF_DOMAIN, pubkey.toBytes()));
}

function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a];
  return keccak_256(concat(NODE_DOMAIN, lo, hi));
}

/**
 * Build a keccak256 sorted-pair (OZ-style) merkle tree over a list of
 * resolver pubkeys. Returns the root and a `proofFor(pk)` accessor that
 * produces a proof for any member. Matches the on-chain verifier in
 * `programs/clearstone-fusion/src/merkle.rs`.
 */
export function buildResolverMerkleTree(resolvers: PublicKey[]): {
  root: number[];
  proofFor: (pk: PublicKey) => number[][];
} {
  if (resolvers.length === 0) {
    throw new Error("cannot build merkle tree over empty resolver set");
  }
  const leaves = resolvers.map(hashLeaf);
  const levels: Uint8Array[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(
        i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]
      );
    }
    levels.push(next);
  }
  const root = Array.from(levels[levels.length - 1][0]);

  const leafIndex = new Map<string, number>();
  resolvers.forEach((pk, i) => leafIndex.set(pk.toBase58(), i));

  function proofFor(pk: PublicKey): number[][] {
    const start = leafIndex.get(pk.toBase58());
    if (start === undefined) {
      throw new Error(`pubkey ${pk.toBase58()} not in tree`);
    }
    const proof: number[][] = [];
    let idx = start;
    for (let lvl = 0; lvl < levels.length - 1; lvl++) {
      const sibling = idx ^ 1;
      if (sibling < levels[lvl].length) {
        proof.push(Array.from(levels[lvl][sibling]));
      }
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  return { root, proofFor };
}
