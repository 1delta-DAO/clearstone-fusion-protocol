import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider } from "anchor-bankrun";
import { BanksClient, ProgramTestContext } from "solana-bankrun";
import { ClearstoneFusion } from "../../target/types/clearstone_fusion";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { TestState, setCurrentTime, trackReceivedTokenAndTx } from "../utils/utils";
import { Transaction } from "@solana/web3.js";

const ClearstoneFusionIDL = require("../../target/idl/clearstone_fusion.json");
chai.use(chaiAsPromised);

const BASE_POINTS = 100000;

describe("Dutch auction (pull model)", () => {
  let provider: BankrunProvider;
  let banksClient: BanksClient;
  let context: ProgramTestContext;
  let state: TestState;
  let program: anchor.Program<ClearstoneFusion>;
  let payer: anchor.web3.Keypair;

  const auction = {
    startTime: 0,
    duration: 32000,
    initialRateBump: 50000,
    pointsAndTimeDeltas: [
      { rateBump: 20000, timeDelta: 10000 },
      { rateBump: 10000, timeDelta: 20000 },
    ],
  };

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

  it("applies the initial rate bump when the auction hasn't started", async () => {
    const now = Math.floor(new Date().getTime() / 1000);
    auction.startTime = now + 60;
    await setCurrentTime(context, now);

    const signed = state.createSignedOrder({
      programId: program.programId,
      orderConfig: { dutchAuctionData: auction },
    });

    const { ixs, signers } = await state.buildFillTx({
      program,
      signedOrder: signed,
      amount: state.defaultSrcAmount,
    });

    const results = await trackReceivedTokenAndTx(
      provider.connection,
      [state.alice.atas[state.tokens[1].toString()].address],
      async () => {
        const tx = new Transaction().add(...ixs);
        tx.recentBlockhash = (await banksClient.getLatestBlockhash())[0];
        tx.feePayer = signers[0].publicKey;
        tx.sign(...signers);
        await banksClient.processTransaction(tx);
      }
    );

    const expectedDst = BigInt(
      (state.defaultDstAmount.toNumber() *
        (BASE_POINTS + auction.initialRateBump)) /
        BASE_POINTS
    );
    expect(results[0]).to.eq(expectedDst);
  });
});
