import * as anchor from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
import { BankrunProvider } from "anchor-bankrun";
import { BanksClient, ProgramTestContext } from "solana-bankrun";
import { ClearstoneFusion } from "../../target/types/clearstone_fusion";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import {
  TestState,
  setCurrentTime,
} from "../utils/utils";
import {
  MAX_ALLOWED_LIST_LEN,
  MAX_MERKLE_PROOF_LEN,
  permissionlessPolicy,
} from "../../scripts/utils";
import { ResolverPolicy } from "../../ts-common/common";
import { buildResolverMerkleTree, hashLeaf } from "../utils/merkle";

const ClearstoneFusionIDL = require("../../target/idl/clearstone_fusion.json");
chai.use(chaiAsPromised);

function allowedList(pubkeys: anchor.web3.PublicKey[]): ResolverPolicy {
  return { allowedList: { "0": pubkeys } };
}

function merkleRoot(root: number[]): ResolverPolicy {
  return { merkleRoot: { "0": root } };
}

describe("Resolver policy", () => {
  let provider: BankrunProvider;
  let banksClient: BanksClient;
  let context: ProgramTestContext;
  let state: TestState;
  let program: anchor.Program<ClearstoneFusion>;
  let payer: anchor.web3.Keypair;

  const defaultSrcAmount = new anchor.BN(1000000);
  const defaultMaxCancellationPremium = defaultSrcAmount
    .muln(50 * 100)
    .divn(100 * 100);

  before(async () => {
    const usersKeypairs = [];
    for (let i = 0; i < 4; i++) {
      usersKeypairs.push(anchor.web3.Keypair.generate());
    }
    context = await TestState.bankrunContext(usersKeypairs);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    banksClient = context.banksClient;
    payer = context.payer;

    program = new anchor.Program<ClearstoneFusion>(
      ClearstoneFusionIDL,
      provider
    );

    state = await TestState.bankrunCreate(context, payer, usersKeypairs, {
      tokensNums: 3,
    });
  });

  beforeEach(async () => {
    await setCurrentTime(context, Math.floor(new Date().getTime() / 1000));
  });

  // ---------- AllowedList — fill ----------

  describe("AllowedList", () => {
    it("empty list is permissionless: any taker fills", async () => {
      const escrow = await state.createEscrow({
        escrowProgram: program,
        payer,
        provider: banksClient,
        orderConfig: { resolverPolicy: permissionlessPolicy() },
      });

      await program.methods
        .fill(escrow.orderConfig, defaultSrcAmount.divn(2), null)
        .accountsPartial(
          state.buildAccountsDataForFill({
            taker: state.charlie.keypair.publicKey,
            escrow: escrow.escrow,
            escrowSrcAta: escrow.ata,
            takerSrcAta:
              state.charlie.atas[state.tokens[0].toString()].address,
            takerDstAta:
              state.charlie.atas[state.tokens[1].toString()].address,
          })
        )
        .signers([state.charlie.keypair])
        .rpc();
    });

    it("listed taker fills; unlisted taker reverts UnauthorizedResolver", async () => {
      const escrow = await state.createEscrow({
        escrowProgram: program,
        payer,
        provider: banksClient,
        orderConfig: {
          resolverPolicy: allowedList([state.bob.keypair.publicKey]),
        },
      });

      // Bob (in the list) succeeds.
      await program.methods
        .fill(escrow.orderConfig, defaultSrcAmount.divn(2), null)
        .accountsPartial(
          state.buildAccountsDataForFill({
            escrow: escrow.escrow,
            escrowSrcAta: escrow.ata,
          })
        )
        .signers([state.bob.keypair])
        .rpc();

      // Charlie (not in the list) reverts.
      const escrow2 = await state.createEscrow({
        escrowProgram: program,
        payer,
        provider: banksClient,
        orderConfig: {
          resolverPolicy: allowedList([state.bob.keypair.publicKey]),
        },
      });

      await expect(
        program.methods
          .fill(escrow2.orderConfig, defaultSrcAmount.divn(2), null)
          .accountsPartial(
            state.buildAccountsDataForFill({
              taker: state.charlie.keypair.publicKey,
              escrow: escrow2.escrow,
              escrowSrcAta: escrow2.ata,
              takerSrcAta:
                state.charlie.atas[state.tokens[0].toString()].address,
              takerDstAta:
                state.charlie.atas[state.tokens[1].toString()].address,
            })
          )
          .signers([state.charlie.keypair])
          .rpc()
      ).to.be.rejectedWith("Error Code: UnauthorizedResolver");
    });

    it("rejects AllowedListTooLong at create time", async () => {
      const oversized = [];
      for (let i = 0; i < MAX_ALLOWED_LIST_LEN + 1; i++) {
        oversized.push(anchor.web3.Keypair.generate().publicKey);
      }
      await expect(
        state.createEscrow({
          escrowProgram: program,
          payer,
          provider: banksClient,
          orderConfig: { resolverPolicy: allowedList(oversized) },
        })
      ).to.be.rejectedWith("Error Code: AllowedListTooLong");
    });

    it("rejects merkle proof passed to AllowedList order with UnexpectedMerkleProof", async () => {
      const escrow = await state.createEscrow({
        escrowProgram: program,
        payer,
        provider: banksClient,
        orderConfig: {
          resolverPolicy: allowedList([state.bob.keypair.publicKey]),
        },
      });
      const stuffedProof = [Array(32).fill(0)];
      await expect(
        program.methods
          .fill(escrow.orderConfig, defaultSrcAmount.divn(2), stuffedProof)
          .accountsPartial(
            state.buildAccountsDataForFill({
              escrow: escrow.escrow,
              escrowSrcAta: escrow.ata,
            })
          )
          .signers([state.bob.keypair])
          .rpc()
      ).to.be.rejectedWith("Error Code: UnexpectedMerkleProof");
    });
  });

  // ---------- MerkleRoot — fill ----------

  describe("MerkleRoot", () => {
    it("valid proof fills", async () => {
      const { root, proofFor } = buildResolverMerkleTree([
        state.bob.keypair.publicKey,
        state.charlie.keypair.publicKey,
      ]);
      const escrow = await state.createEscrow({
        escrowProgram: program,
        payer,
        provider: banksClient,
        orderConfig: { resolverPolicy: merkleRoot(root) },
      });

      await program.methods
        .fill(
          escrow.orderConfig,
          defaultSrcAmount.divn(2),
          proofFor(state.bob.keypair.publicKey)
        )
        .accountsPartial(
          state.buildAccountsDataForFill({
            escrow: escrow.escrow,
            escrowSrcAta: escrow.ata,
          })
        )
        .signers([state.bob.keypair])
        .rpc();
    });

    it("missing proof reverts MissingMerkleProof", async () => {
      const { root } = buildResolverMerkleTree([state.bob.keypair.publicKey]);
      const escrow = await state.createEscrow({
        escrowProgram: program,
        payer,
        provider: banksClient,
        orderConfig: { resolverPolicy: merkleRoot(root) },
      });

      await expect(
        program.methods
          .fill(escrow.orderConfig, defaultSrcAmount.divn(2), null)
          .accountsPartial(
            state.buildAccountsDataForFill({
              escrow: escrow.escrow,
              escrowSrcAta: escrow.ata,
            })
          )
          .signers([state.bob.keypair])
          .rpc()
      ).to.be.rejectedWith("Error Code: MissingMerkleProof");
    });

    it("wrong proof reverts InvalidMerkleProof", async () => {
      const { root } = buildResolverMerkleTree([
        state.bob.keypair.publicKey,
        state.charlie.keypair.publicKey,
      ]);
      const escrow = await state.createEscrow({
        escrowProgram: program,
        payer,
        provider: banksClient,
        orderConfig: { resolverPolicy: merkleRoot(root) },
      });

      // Pretend Dave (not in the tree) tries to fill with a sibling from
      // bob's branch — the hash won't reconstruct to the root.
      const daveLeaf = Array.from(hashLeaf(state.dave.keypair.publicKey));

      await expect(
        program.methods
          .fill(escrow.orderConfig, defaultSrcAmount.divn(2), [daveLeaf])
          .accountsPartial(
            state.buildAccountsDataForFill({
              taker: state.dave.keypair.publicKey,
              escrow: escrow.escrow,
              escrowSrcAta: escrow.ata,
              takerSrcAta:
                state.dave.atas[state.tokens[0].toString()].address,
              takerDstAta:
                state.dave.atas[state.tokens[1].toString()].address,
            })
          )
          .signers([state.dave.keypair])
          .rpc()
      ).to.be.rejectedWith("Error Code: InvalidMerkleProof");
    });

    it("too-deep proof reverts MerkleProofTooDeep", async () => {
      const { root } = buildResolverMerkleTree([state.bob.keypair.publicKey]);
      const escrow = await state.createEscrow({
        escrowProgram: program,
        payer,
        provider: banksClient,
        orderConfig: { resolverPolicy: merkleRoot(root) },
      });

      const tooDeep: number[][] = [];
      for (let i = 0; i < MAX_MERKLE_PROOF_LEN + 1; i++) {
        tooDeep.push(Array(32).fill(0));
      }

      await expect(
        program.methods
          .fill(escrow.orderConfig, defaultSrcAmount.divn(2), tooDeep)
          .accountsPartial(
            state.buildAccountsDataForFill({
              escrow: escrow.escrow,
              escrowSrcAta: escrow.ata,
            })
          )
          .signers([state.bob.keypair])
          .rpc()
      ).to.be.rejectedWith("Error Code: MerkleProofTooDeep");
    });
  });

  // ---------- Policy binding regression ----------

  describe("Policy binding", () => {
    it("mutating resolver_policy after create breaks escrow PDA derivation", async () => {
      const escrow = await state.createEscrow({
        escrowProgram: program,
        payer,
        provider: banksClient,
        orderConfig: {
          resolverPolicy: allowedList([state.bob.keypair.publicKey]),
        },
      });

      // Try to fill using an OrderConfig whose policy was swapped after
      // create — this changes order_hash and therefore the escrow PDA.
      const mutatedOrderConfig = {
        ...escrow.orderConfig,
        resolverPolicy: allowedList([state.charlie.keypair.publicKey]),
      };

      await expect(
        program.methods
          .fill(mutatedOrderConfig, defaultSrcAmount.divn(2), null)
          .accountsPartial(
            state.buildAccountsDataForFill({
              escrow: escrow.escrow,
              escrowSrcAta: escrow.ata,
            })
          )
          .signers([state.bob.keypair])
          .rpc()
      ).to.be.rejectedWith("Error Code: ConstraintSeeds");
    });
  });

  // ---------- cancel_by_resolver — mirror policy enforcement ----------

  describe("cancel_by_resolver", () => {
    it("listed resolver cancels; unlisted reverts UnauthorizedResolver", async () => {
      const escrow = await state.createEscrow({
        escrowProgram: program,
        payer,
        provider: banksClient,
        orderConfig: state.orderConfig({
          srcAmount: defaultSrcAmount,
          resolverPolicy: allowedList([state.bob.keypair.publicKey]),
          fee: {
            maxCancellationPremium: defaultMaxCancellationPremium,
            protocolDstAcc: undefined,
            integratorDstAcc: undefined,
            protocolFee: undefined,
            integratorFee: undefined,
            surplusPercentage: undefined,
          },
          cancellationAuctionDuration: 32000,
        }),
      });

      await setCurrentTime(context, state.defaultExpirationTime + 1);

      await expect(
        program.methods
          .cancelByResolver(escrow.orderConfig, new anchor.BN(0), null)
          .accountsPartial({
            resolver: state.charlie.keypair.publicKey,
            maker: state.alice.keypair.publicKey,
            makerReceiver: escrow.orderConfig.receiver,
            srcMint: escrow.orderConfig.srcMint,
            dstMint: escrow.orderConfig.dstMint,
            escrow: escrow.escrow,
            escrowSrcAta: escrow.ata,
            protocolDstAcc: escrow.orderConfig.fee.protocolDstAcc,
            integratorDstAcc: escrow.orderConfig.fee.integratorDstAcc,
            srcTokenProgram: splToken.TOKEN_PROGRAM_ID,
          })
          .signers([state.charlie.keypair])
          .rpc()
      ).to.be.rejectedWith("Error Code: UnauthorizedResolver");

      // Bob (listed) succeeds.
      await program.methods
        .cancelByResolver(escrow.orderConfig, new anchor.BN(0), null)
        .accountsPartial({
          resolver: state.bob.keypair.publicKey,
          maker: state.alice.keypair.publicKey,
          makerReceiver: escrow.orderConfig.receiver,
          srcMint: escrow.orderConfig.srcMint,
          dstMint: escrow.orderConfig.dstMint,
          escrow: escrow.escrow,
          escrowSrcAta: escrow.ata,
          protocolDstAcc: escrow.orderConfig.fee.protocolDstAcc,
          integratorDstAcc: escrow.orderConfig.fee.integratorDstAcc,
          srcTokenProgram: splToken.TOKEN_PROGRAM_ID,
        })
        .signers([state.bob.keypair])
        .rpc();
    });
  });
});
