import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  Ed25519Program,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import os from "os";
import * as splToken from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import * as borsh from "borsh";
import nacl from "tweetnacl";
import {
  OrderConfig,
  FeeConfig,
  AuctionData,
  ResolverPolicy,
} from "../ts-common/common";
export { OrderConfig, FeeConfig, ResolverPolicy };

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
const prompt = require("prompt-sync")({ sigint: true });

export const MAX_ALLOWED_LIST_LEN = 10;
export const MAX_MERKLE_PROOF_LEN = 10;

export const DELEGATE_SEED = anchor.utils.bytes.utf8.encode("delegate");
export const ORDER_STATE_SEED = anchor.utils.bytes.utf8.encode("order");

export function permissionlessPolicy(): ResolverPolicy {
  return { allowedList: { "0": [] } };
}

function normalizeResolverPolicyForBorsh(policy: ResolverPolicy): object {
  if ("allowedList" in policy) {
    return {
      allowedList: {
        "0": policy.allowedList["0"].map((pk) => pk.toBuffer()),
      },
    };
  }
  return { merkleRoot: { "0": policy.merkleRoot["0"] } };
}

export const defaultFeeConfig: FeeConfig = {
  protocolFee: 0,
  integratorFee: 0,
  surplusPercentage: 0,
  protocolDstAcc: null,
  integratorDstAcc: null,
};

export const defaultAuctionData: AuctionData = {
  startTime: 0xffffffff - 32000, // default auction start in the far far future and order use default formula
  duration: 32000,
  initialRateBump: 0,
  pointsAndTimeDeltas: [],
};

export async function getTokenDecimals(
  connection: Connection,
  mint: PublicKey
): Promise<number> {
  const mintAccount = await splToken.getMint(connection, mint);
  return mintAccount.decimals;
}

export async function loadKeypairFromFile(
  filePath: string
): Promise<Keypair | undefined> {
  const resolvedPath = path.resolve(
    filePath.startsWith("~") ? filePath.replace("~", os.homedir()) : filePath
  );
  try {
    const raw = fs.readFileSync(resolvedPath);
    const formattedData = JSON.parse(raw.toString());
    return Keypair.fromSecretKey(Uint8Array.from(formattedData));
  } catch (error) {
    throw new Error(
      `Error reading keypair from file: ${(error as Error).message}`
    );
  }
}

/** PDA of the program's single delegate authority (maker approves this). */
export function findDelegateAuthority(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([DELEGATE_SEED], programId);
  return pda;
}

/** PDA of the per-order OrderState tracking partial fills / cancellation. */
export function findOrderStateAddress(
  programId: PublicKey,
  maker: PublicKey,
  orderHash: Buffer | Uint8Array
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [ORDER_STATE_SEED, maker.toBuffer(), Buffer.from(orderHash)],
    programId
  );
  return pda;
}

export function defaultExpirationTime(): number {
  return ~~(new Date().getTime() / 1000) + 86400; // now + 1 day
}

export function getClusterUrlEnv() {
  const clusterUrl = process.env.CLUSTER_URL;
  if (!clusterUrl) {
    throw new Error("Missing CLUSTER_URL environment variable");
  }
  return clusterUrl;
}

const orderConfigSchema = {
  struct: {
    id: "u32",
    srcAmount: "u64",
    minDstAmount: "u64",
    estimatedDstAmount: "u64",
    expirationTime: "u32",
    dstAssetIsNative: "bool",
    fee: {
      struct: {
        protocolFee: "u16",
        integratorFee: "u16",
        surplusPercentage: "u8",
      },
    },
    dutchAuctionData: {
      struct: {
        startTime: "u32",
        duration: "u32",
        initialRateBump: "u16",
        pointsAndTimeDeltas: {
          array: {
            type: {
              struct: {
                rateBump: "u16",
                timeDelta: "u16",
              },
            },
          },
        },
      },
    },
    resolverPolicy: {
      enum: [
        {
          struct: {
            allowedList: {
              struct: {
                "0": {
                  array: { type: { array: { type: "u8", len: 32 } } },
                },
              },
            },
          },
        },
        {
          struct: {
            merkleRoot: {
              struct: {
                "0": { array: { type: "u8", len: 32 } },
              },
            },
          },
        },
      ],
    },

    // Accounts appended after `OrderConfig`; hashed together for domain integrity.
    protocolDstAcc: { option: { array: { type: "u8", len: 32 } } },
    integratorDstAcc: { option: { array: { type: "u8", len: 32 } } },
    srcMint: { array: { type: "u8", len: 32 } },
    dstMint: { array: { type: "u8", len: 32 } },
    receiver: { array: { type: "u8", len: 32 } },
  },
};

/**
 * Canonical order hash. Domain-separated by `programId` so a signature over
 * one deployment cannot be replayed against another. Must match the Rust
 * `order_hash` function exactly.
 */
export function calculateOrderHash(
  programId: PublicKey,
  orderConfig: OrderConfig
): Uint8Array {
  const values = {
    id: orderConfig.id,
    srcAmount: orderConfig.srcAmount.toNumber(),
    minDstAmount: orderConfig.minDstAmount.toNumber(),
    estimatedDstAmount: orderConfig.estimatedDstAmount.toNumber(),
    expirationTime: orderConfig.expirationTime,
    dstAssetIsNative: orderConfig.dstAssetIsNative,
    fee: {
      protocolFee: orderConfig.fee.protocolFee,
      integratorFee: orderConfig.fee.integratorFee,
      surplusPercentage: orderConfig.fee.surplusPercentage,
    },
    dutchAuctionData: {
      startTime: orderConfig.dutchAuctionData.startTime,
      duration: orderConfig.dutchAuctionData.duration,
      initialRateBump: orderConfig.dutchAuctionData.initialRateBump,
      pointsAndTimeDeltas: orderConfig.dutchAuctionData.pointsAndTimeDeltas.map(
        (p) => ({ rateBump: p.rateBump, timeDelta: p.timeDelta })
      ),
    },
    resolverPolicy: normalizeResolverPolicyForBorsh(orderConfig.resolverPolicy),
    protocolDstAcc: orderConfig.fee.protocolDstAcc?.toBuffer(),
    integratorDstAcc: orderConfig.fee.integratorDstAcc?.toBuffer(),
    srcMint: orderConfig.srcMint.toBuffer(),
    dstMint: orderConfig.dstMint.toBuffer(),
    receiver: orderConfig.receiver.toBuffer(),
  };

  const body = borsh.serialize(orderConfigSchema, values);
  const prefixed = Buffer.concat([programId.toBuffer(), Buffer.from(body)]);
  return sha256(prefixed);
}

/** Maker-side: sign the order hash with Ed25519. Returns 64-byte signature. */
export function signOrderHash(
  orderHash: Uint8Array,
  makerKeypair: Keypair
): Uint8Array {
  return nacl.sign.detached(orderHash, makerKeypair.secretKey);
}

/**
 * Build the native Ed25519 verify instruction that must immediately precede
 * `fill`. The fill handler reads this from the Instructions sysvar to prove
 * the maker signed the order hash.
 */
export function buildEd25519VerifyIx(
  makerPubkey: PublicKey,
  orderHash: Uint8Array,
  signature: Uint8Array
): TransactionInstruction {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: makerPubkey.toBytes(),
    message: orderHash,
    signature,
  });
}

/** Prompt helper for CLI scripts. */
export function prompt_(key: string, pmpt: string): string {
  const argv = yargs(hideBin(process.argv)).parse();
  if (key in argv) {
    return argv[key];
  } else {
    return prompt(pmpt);
  }
}
