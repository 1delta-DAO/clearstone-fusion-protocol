import { PublicKey } from "@solana/web3.js";
const createKeccak = require("keccak");

const LEAF_DOMAIN = Buffer.from([0x00]);
const NODE_DOMAIN = Buffer.from([0x01]);

function keccak256(...chunks: Buffer[]): Buffer {
  const h = createKeccak("keccak256");
  for (const c of chunks) h.update(c);
  return h.digest();
}

export function hashLeaf(pubkey: PublicKey): Buffer {
  return keccak256(LEAF_DOMAIN, pubkey.toBuffer());
}

function hashPair(a: Buffer, b: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return keccak256(NODE_DOMAIN, lo, hi);
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
  // `levels[0]` = leaves, `levels[levels.length - 1]` = [root].
  const levels: Buffer[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 < prev.length) {
        next.push(hashPair(prev[i], prev[i + 1]));
      } else {
        // Odd leaf is promoted unchanged to the next level.
        next.push(prev[i]);
      }
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
