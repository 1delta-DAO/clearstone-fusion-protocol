import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider } from "anchor-bankrun";
import { BanksClient, ProgramTestContext } from "solana-bankrun";
import { ClearstoneFusion } from "../../target/types/clearstone_fusion";
import { TestState, expectProgramError } from "../utils/utils";
import { MAX_ALLOWED_LIST_LEN } from "../../scripts/utils";
import { ResolverPolicy } from "../../ts-common/common";
import { buildResolverMerkleTree, hashLeaf } from "../utils/merkle";
import { Transaction } from "@solana/web3.js";

const ClearstoneFusionIDL = require("../../target/idl/clearstone_fusion.json");

function allowedList(pubkeys: anchor.web3.PublicKey[]): ResolverPolicy {
  return { allowedList: { "0": pubkeys } };
}
function merkleRoot(root: number[]): ResolverPolicy {
  return { merkleRoot: { "0": root } };
}

describe("Resolver policy (pull model)", () => {
  let provider: BankrunProvider;
  let banksClient: BanksClient;
  let context: ProgramTestContext;
  let state: TestState;
  let program: anchor.Program<ClearstoneFusion>;
  let payer: anchor.web3.Keypair;

  before(async () => {
    const users = [];
    for (let i = 0; i < 4; i++) users.push(anchor.web3.Keypair.generate());
    context = await TestState.bankrunContext(users);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    banksClient = context.banksClient;
    payer = context.payer;

    program = new anchor.Program<ClearstoneFusion>(
      ClearstoneFusionIDL,
      provider
    );
    state = await TestState.bankrunCreate(context, payer, users, {
      tokensNums: 3,
    });
    await state.approveDelegate({ program, provider: banksClient, payer });
  });

  async function sendFillAs(
    signed: ReturnType<TestState["createSignedOrder"]>,
    taker: typeof state.bob,
    merkleProof: number[][] | null = null
  ) {
    const { ixs, signers } = await state.buildFillTx({
      program,
      signedOrder: signed,
      amount: state.defaultSrcAmount,
      taker,
      merkleProof,
    });
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = (await banksClient.getLatestBlockhash())[0];
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    return banksClient.processTransaction(tx);
  }

  describe("AllowedList", () => {
    it("empty list is permissionless (any taker fills)", async () => {
      const signed = state.createSignedOrder({
        programId: program.programId,
        orderConfig: { resolverPolicy: { allowedList: { "0": [] } } },
      });
      await sendFillAs(signed, state.charlie);
    });

    it("listed taker fills; unlisted taker reverts UnauthorizedResolver", async () => {
      const signed1 = state.createSignedOrder({
        programId: program.programId,
        orderConfig: {
          resolverPolicy: allowedList([state.bob.keypair.publicKey]),
        },
      });
      await sendFillAs(signed1, state.bob);

      const signed2 = state.createSignedOrder({
        programId: program.programId,
        orderConfig: {
          resolverPolicy: allowedList([state.bob.keypair.publicKey]),
        },
      });
      await expectProgramError(
        program,
        sendFillAs(signed2, state.charlie),
        "UnauthorizedResolver"
      );
    });

    it("reverts AllowedListTooLong when the inline list is oversized", async () => {
      const oversized = [];
      for (let i = 0; i < MAX_ALLOWED_LIST_LEN + 1; i++) {
        oversized.push(anchor.web3.Keypair.generate().publicKey);
      }
      const signed = state.createSignedOrder({
        programId: program.programId,
        orderConfig: { resolverPolicy: allowedList(oversized) },
      });
      await expectProgramError(
        program,
        sendFillAs(signed, state.bob),
        "AllowedListTooLong"
      );
    });

    it("reverts UnexpectedMerkleProof when a proof is supplied to an AllowedList order", async () => {
      const signed = state.createSignedOrder({
        programId: program.programId,
        orderConfig: {
          resolverPolicy: allowedList([state.bob.keypair.publicKey]),
        },
      });
      await expectProgramError(
        program,
        sendFillAs(signed, state.bob, [Array(32).fill(0)]),
        "UnexpectedMerkleProof"
      );
    });
  });

  describe("MerkleRoot", () => {
    it("valid proof fills", async () => {
      const { root, proofFor } = buildResolverMerkleTree([
        state.bob.keypair.publicKey,
        state.charlie.keypair.publicKey,
      ]);
      const signed = state.createSignedOrder({
        programId: program.programId,
        orderConfig: { resolverPolicy: merkleRoot(root) },
      });
      await sendFillAs(
        signed,
        state.bob,
        proofFor(state.bob.keypair.publicKey)
      );
    });

    it("missing proof reverts MissingMerkleProof", async () => {
      const { root } = buildResolverMerkleTree([state.bob.keypair.publicKey]);
      const signed = state.createSignedOrder({
        programId: program.programId,
        orderConfig: { resolverPolicy: merkleRoot(root) },
      });
      await expectProgramError(
        program,
        sendFillAs(signed, state.bob, null),
        "MissingMerkleProof"
      );
    });

    it("wrong proof reverts InvalidMerkleProof", async () => {
      const { root } = buildResolverMerkleTree([
        state.bob.keypair.publicKey,
        state.charlie.keypair.publicKey,
      ]);
      const signed = state.createSignedOrder({
        programId: program.programId,
        orderConfig: { resolverPolicy: merkleRoot(root) },
      });
      const bogus = Array.from(hashLeaf(state.dave.keypair.publicKey));
      await expectProgramError(
        program,
        sendFillAs(signed, state.dave, [bogus]),
        "InvalidMerkleProof"
      );
    });
  });
});
