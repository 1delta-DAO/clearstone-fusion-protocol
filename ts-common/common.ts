import * as anchor from "@coral-xyz/anchor";

const ClearstoneFusionIDL = require("../target/idl/clearstone_fusion.json");

const escrowType = ClearstoneFusionIDL.types.find((t) => t.name === "Escrow");
export type Escrow = (typeof escrowType)["type"]["fields"];

const auctionDataType = ClearstoneFusionIDL.types.find(
  (t) => t.name === "AuctionData"
);
export type AuctionData = (typeof auctionDataType)["type"]["fields"];

export type FeeConfig = {
  protocolDstAcc: anchor.web3.PublicKey | null;
  integratorDstAcc: anchor.web3.PublicKey | null;
  protocolFee: number;
  integratorFee: number;
  surplusPercentage: number;
  maxCancellationPremium: anchor.BN;
};

/**
 * Discriminated union mirroring the Anchor `ResolverPolicy` enum.
 * Variants (frozen discriminants): 0 = `allowedList`, 1 = `merkleRoot`.
 * An empty `allowedList` means permissionless (any taker may fill).
 */
export type ResolverPolicy =
  | { allowedList: { "0": anchor.web3.PublicKey[] } }
  | { merkleRoot: { "0": number[] } };

export type OrderConfig = {
  id: number;
  srcAmount: anchor.BN;
  minDstAmount: anchor.BN;
  estimatedDstAmount: anchor.BN;
  expirationTime: number;
  srcAssetIsNative: boolean;
  dstAssetIsNative: boolean;
  fee: FeeConfig;
  dutchAuctionData: AuctionData;
  cancellationAuctionDuration: number;
  resolverPolicy: ResolverPolicy;
  srcMint: anchor.web3.PublicKey | null;
  dstMint: anchor.web3.PublicKey | null;
  receiver: anchor.web3.PublicKey | null;
};
