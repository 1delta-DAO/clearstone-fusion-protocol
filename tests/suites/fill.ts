import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider } from "anchor-bankrun";
import { BanksClient, ProgramTestContext } from "solana-bankrun";
import { ClearstoneFusion } from "../../target/types/clearstone_fusion";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { TestState, trackReceivedTokenAndTx } from "../utils/utils";
import { Transaction } from "@solana/web3.js";

const ClearstoneFusionIDL = require("../../target/idl/clearstone_fusion.json");
chai.use(chaiAsPromised);

describe("Fill (pull model)", () => {
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

    // Alice approves the delegate PDA once on tokens[0] (her src asset).
    // Covers every fill in this suite.
    await state.approveDelegate({ program, provider: banksClient, payer });
  });

  async function sendFill(
    signedOrder: ReturnType<TestState["createSignedOrder"]>,
    amount: anchor.BN,
    taker = state.bob
  ) {
    const { ixs, signers } = await state.buildFillTx({
      program,
      signedOrder,
      amount,
      taker,
    });
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = (await banksClient.getLatestBlockhash())[0];
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    return banksClient.processTransaction(tx);
  }

  it("executes a full fill (SPL src, SPL dst) without pre-deposit", async () => {
    const signed = state.createSignedOrder({ programId: program.programId });

    const results = await trackReceivedTokenAndTx(
      provider.connection,
      [
        state.alice.atas[state.tokens[1].toString()].address,
        state.bob.atas[state.tokens[0].toString()].address,
        state.alice.atas[state.tokens[0].toString()].address,
      ],
      () => sendFill(signed, state.defaultSrcAmount)
    );

    expect(results).to.deep.eq([
      BigInt(state.defaultDstAmount.toNumber()),
      BigInt(state.defaultSrcAmount.toNumber()),
      -BigInt(state.defaultSrcAmount.toNumber()),
    ]);

    const orderState = await program.account.orderState.fetch(
      signed.orderStatePda
    );
    expect(orderState.filledAmount.toNumber()).to.eq(
      state.defaultSrcAmount.toNumber()
    );
    expect(orderState.canceled).to.eq(false);
  });

  it("accumulates partial fills; reverts once the order is fully filled", async () => {
    const signed = state.createSignedOrder({ programId: program.programId });
    // Use distinct amounts so bankrun doesn't dedupe the two fills as
    // identical transactions.
    const first = state.defaultSrcAmount.muln(40).divn(100);
    const second = state.defaultSrcAmount.sub(first);

    await sendFill(signed, first);
    await sendFill(signed, second);

    const orderState = await program.account.orderState.fetch(
      signed.orderStatePda
    );
    expect(orderState.filledAmount.toNumber()).to.eq(
      state.defaultSrcAmount.toNumber()
    );

    await expect(sendFill(signed, new anchor.BN(1))).to.be.rejected;
  });

  it("fails if the maker never approved the delegate on the src ATA", async () => {
    // Bob has never approved the delegate on tokens[1], so a bob-signed order
    // pulling tokens[1] from bob cannot settle even though the signature is valid.
    const srcMint = state.tokens[1];
    const dstMint = state.tokens[0];
    const signed = state.createSignedOrder({
      programId: program.programId,
      makerKeypair: state.bob.keypair,
      orderConfig: {
        srcMint,
        dstMint,
        srcAmount: new anchor.BN(10),
        minDstAmount: new anchor.BN(5),
        estimatedDstAmount: new anchor.BN(5),
        receiver: state.bob.keypair.publicKey,
      },
    });

    const { ixs } = await state.buildFillTx({
      program,
      signedOrder: signed,
      amount: new anchor.BN(10),
      taker: state.alice,
      extraAccounts: {
        makerSrcAta: state.bob.atas[srcMint.toString()].address,
        takerSrcAta: state.alice.atas[srcMint.toString()].address,
        makerDstAta: state.bob.atas[dstMint.toString()].address,
        takerDstAta: state.alice.atas[dstMint.toString()].address,
      },
    });
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = (await banksClient.getLatestBlockhash())[0];
    tx.feePayer = state.alice.keypair.publicKey;
    tx.sign(state.alice.keypair);

    await expect(banksClient.processTransaction(tx)).to.be.rejected;
  });
});
