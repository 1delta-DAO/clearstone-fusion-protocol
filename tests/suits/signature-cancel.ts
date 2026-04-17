import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider } from "anchor-bankrun";
import { BanksClient, ProgramTestContext } from "solana-bankrun";
import { ClearstoneFusion } from "../../target/types/clearstone_fusion";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import {
  TestState,
  expectProgramError,
  setCurrentTime,
} from "../utils/utils";
import {
  buildEd25519VerifyIx,
  signOrderHash,
} from "../../scripts/utils";
import { Transaction, TransactionInstruction } from "@solana/web3.js";

const ClearstoneFusionIDL = require("../../target/idl/clearstone_fusion.json");
chai.use(chaiAsPromised);

describe("Signature enforcement, cancel & cleanup", () => {
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

  async function sendTx(
    ixs: TransactionInstruction[],
    signers: anchor.web3.Keypair[]
  ): Promise<void> {
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = (await banksClient.getLatestBlockhash())[0];
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    await banksClient.processTransaction(tx);
  }

  async function sendFill(
    signedOrder: ReturnType<TestState["createSignedOrder"]>,
    tamper: (ixs: TransactionInstruction[]) => void = () => {}
  ): Promise<void> {
    const { ixs, signers } = await state.buildFillTx({
      program,
      signedOrder,
      amount: state.defaultSrcAmount,
    });
    tamper(ixs);
    await sendTx(ixs, signers);
  }

  // ---------- Ed25519 enforcement ----------

  it("reverts with MissingSignatureInstruction when the verify ix is absent", async () => {
    const signed = state.createSignedOrder({ programId: program.programId });
    await expectProgramError(
      program,
      sendFill(signed, (ixs) => ixs.shift()),
      "MissingSignatureInstruction"
    );
  });

  it("reverts MessageMismatch when the verify ix signs a different message", async () => {
    const signed = state.createSignedOrder({ programId: program.programId });
    const bogus = new Uint8Array(32).fill(0xab);
    const bogusSig = signOrderHash(bogus, signed.makerKeypair);
    const bogusIx = buildEd25519VerifyIx(
      signed.makerKeypair.publicKey,
      bogus,
      bogusSig
    );
    await expectProgramError(
      program,
      sendFill(signed, (ixs) => (ixs[0] = bogusIx)),
      "MessageMismatch"
    );
  });

  it("reverts SignerMismatch when the verify ix signs for a different pubkey", async () => {
    const signed = state.createSignedOrder({ programId: program.programId });
    const intruder = anchor.web3.Keypair.generate();
    const intruderSig = signOrderHash(signed.orderHash, intruder);
    const wrongSignerIx = buildEd25519VerifyIx(
      intruder.publicKey,
      signed.orderHash,
      intruderSig
    );
    await expectProgramError(
      program,
      sendFill(signed, (ixs) => (ixs[0] = wrongSignerIx)),
      "SignerMismatch"
    );
  });

  // ---------- cancel ----------

  it("cancel marks the order; subsequent fill reverts OrderCanceled", async () => {
    const signed = state.createSignedOrder({ programId: program.programId });

    const cancelIx = await program.methods
      .cancel(signed.orderConfig)
      .accountsPartial({
        maker: signed.makerKeypair.publicKey,
        srcMint: signed.orderConfig.srcMint,
        dstMint: signed.orderConfig.dstMint,
        makerReceiver: signed.orderConfig.receiver,
        protocolDstAcc: signed.orderConfig.fee.protocolDstAcc,
        integratorDstAcc: signed.orderConfig.fee.integratorDstAcc,
        orderState: signed.orderStatePda,
      })
      .instruction();
    await sendTx([cancelIx], [signed.makerKeypair]);

    const orderState = await program.account.orderState.fetch(
      signed.orderStatePda
    );
    expect(orderState.canceled).to.eq(true);
    expect(orderState.filledAmount.toNumber()).to.eq(
      signed.orderConfig.srcAmount.toNumber()
    );

    await expectProgramError(program, sendFill(signed), "OrderCanceled");
  });

  // ---------- clean_expired ----------

  it("clean_expired fails before expiration and succeeds after", async () => {
    const signed = state.createSignedOrder({ programId: program.programId });

    // Initialize the OrderState PDA via a partial fill.
    await sendFill(signed);

    async function buildClean(cleaner: anchor.web3.Keypair) {
      return program.methods
        .cleanExpired(Array.from(signed.orderHash))
        .accountsPartial({
          cleaner: cleaner.publicKey,
          maker: signed.makerKeypair.publicKey,
          orderState: signed.orderStatePda,
        })
        .instruction();
    }

    // Use different cleaners on the two attempts so bankrun doesn't dedupe
    // the transactions as identical. (Same program call, but distinct signer
    // + fee payer = distinct tx bytes.)
    const preExpIx = await buildClean(state.charlie.keypair);
    await expectProgramError(
      program,
      sendTx([preExpIx], [state.charlie.keypair]),
      "OrderNotExpired"
    );

    await setCurrentTime(context, signed.orderConfig.expirationTime + 1);

    const postExpIx = await buildClean(state.dave.keypair);
    await sendTx([postExpIx], [state.dave.keypair]);

    const maybe = await banksClient.getAccount(signed.orderStatePda);
    expect(maybe).to.eq(null);
  });
});
