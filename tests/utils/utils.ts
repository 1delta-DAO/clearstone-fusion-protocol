import * as anchor from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
import {
  Transaction,
  sendAndConfirmTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
  TransactionSignature,
  Message,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import * as splBankrunToken from "spl-token-bankrun";
import {
  AccountInfoBytes,
  BanksClient,
  Clock,
  ProgramTestContext,
  startAnchor,
} from "solana-bankrun";
import bs58 from "bs58";
import { ClearstoneFusion } from "../../target/types/clearstone_fusion";
import { SYSTEM_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/native/system";
import {
  buildEd25519VerifyIx,
  calculateOrderHash,
  findDelegateAuthority,
  findOrderStateAddress,
  permissionlessPolicy,
  signOrderHash,
} from "../../scripts/utils";
import { OrderConfig } from "../../ts-common/common";

export type User = {
  keypair: anchor.web3.Keypair;
  atas: {
    [tokenAddress: string]: splToken.Account;
  };
};

/**
 * A maker-signed order ready to be submitted via `fill`. Produced by
 * `TestState.createSignedOrder`. Holds the hash + signature so tests don't
 * need to re-derive them on every fill.
 */
export type SignedOrder = {
  orderConfig: OrderConfig;
  orderHash: Uint8Array;
  signature: Uint8Array;
  orderStatePda: PublicKey;
  makerKeypair: anchor.web3.Keypair;
};

export type CompactFee = {
  protocolFee: number;
  integratorFee: number;
  surplus: number;
};

export function debugLog(message?: any, ...optionalParams: any[]): void {
  if (process.env.DEBUG) {
    console.log(message, ...optionalParams);
  }
}

export type Account = {
  publicKey: PublicKey;
  programId: PublicKey;
};

export async function trackReceivedTokenAndTx(
  connection,
  addresses: Array<PublicKey> | Array<Account>,
  txPromise
): Promise<BigInt[]> {
  const getAccounts = async (address) => {
    return await splToken.getAccount(
      connection,
      address instanceof PublicKey ? address : address.publicKey,
      undefined,
      address instanceof PublicKey
        ? splToken.TOKEN_PROGRAM_ID
        : address.programId
    );
  };

  const tokenBalancesBefore = await Promise.all(addresses.map(getAccounts));
  await txPromise();
  const tokenBalancesAfter = await Promise.all(addresses.map(getAccounts));
  return tokenBalancesAfter.map(
    (b, i) => b.amount - tokenBalancesBefore[i].amount
  );
}

const DEFAULT_AIRDROPINFO = {
  lamports: 1 * LAMPORTS_PER_SOL,
  data: Buffer.alloc(0),
  owner: SYSTEM_PROGRAM_ID,
  executable: false,
};

const DEFAULT_STARTANCHOR = {
  path: ".",
  extraPrograms: [],
  accounts: undefined,
  computeMaxUnits: undefined,
  transactionAccountLockLimit: undefined,
  deactivateFeatures: undefined,
};

export class TestState {
  alice: User;
  bob: User;
  charlie: User;
  dave: User;
  tokens: Array<anchor.web3.PublicKey> = [];
  orders: Array<SignedOrder> = [];
  order_id = 0;
  defaultSrcAmount = new anchor.BN(100);
  defaultDstAmount = new anchor.BN(30);
  defaultExpirationTime = ~~(new Date().getTime() / 1000) + 86400; // now + 1 day
  auction = {
    startTime: 0xffffffff - 32000,
    duration: 32000,
    initialRateBump: 0,
    pointsAndTimeDeltas: [],
  };

  constructor() {}

  static async anchorCreate(
    provider: anchor.AnchorProvider,
    payer: anchor.web3.Keypair,
    settings: { tokensNums: number }
  ): Promise<TestState> {
    const instance = new TestState();
    instance.tokens = await createTokens(settings.tokensNums, provider, payer);
    instance.tokens.push(splToken.NATIVE_MINT);
    [
      instance.alice as User,
      instance.bob as User,
      instance.charlie as User,
      instance.dave as User,
    ] = await createUsers(4, instance.tokens, provider, payer);

    await mintTokens(instance.tokens[0], instance.alice, 100_000_000, provider, payer);
    await mintTokens(instance.tokens[1], instance.bob, 100_000_000, provider, payer);
    await mintTokens(instance.tokens[1], instance.charlie, 100_000_000, provider, payer);
    return instance;
  }

  static async bankrunContext(
    userKeyPairs: anchor.web3.Keypair[],
    params?: typeof DEFAULT_STARTANCHOR,
    airdropInfo?: AccountInfoBytes
  ): Promise<ProgramTestContext> {
    airdropInfo = { ...DEFAULT_AIRDROPINFO, ...airdropInfo };
    params = { ...DEFAULT_STARTANCHOR, ...params };

    return await startAnchor(
      params.path,
      params.extraPrograms,
      params.accounts ||
        userKeyPairs.map((u) => ({ address: u.publicKey, info: airdropInfo })),
      params.computeMaxUnits,
      params.transactionAccountLockLimit,
      params.deactivateFeatures
    );
  }

  static async bankrunCreate(
    context: ProgramTestContext,
    payer: anchor.web3.Keypair,
    usersKeypairs: Array<anchor.web3.Keypair>,
    settings: { tokensNums: number }
  ): Promise<TestState> {
    const provider = context.banksClient;
    const instance = new TestState();
    instance.tokens = await createTokens(settings.tokensNums, provider, payer);
    instance.tokens.push(splToken.NATIVE_MINT);
    [
      instance.alice as User,
      instance.bob as User,
      instance.charlie as User,
      instance.dave as User,
    ] = await createAtasUsers(usersKeypairs, instance.tokens, provider, payer);

    await mintTokens(instance.tokens[0], instance.alice, 100_000_000, provider, payer);
    await mintTokens(instance.tokens[1], instance.bob, 100_000_000, provider, payer);
    await mintTokens(instance.tokens[1], instance.charlie, 100_000_000, provider, payer);
    return instance;
  }

  /**
   * Alice approves the program's delegate PDA to spend up to `amount` of
   * `srcMint` from her ATA. Call once per test setup (or per mint).
   */
  async approveDelegate({
    program,
    provider,
    payer,
    srcMint,
    amount,
    owner,
    srcTokenProgram = splToken.TOKEN_PROGRAM_ID,
  }: {
    program: anchor.Program<ClearstoneFusion>;
    provider: anchor.AnchorProvider | BanksClient;
    payer: anchor.web3.Keypair;
    srcMint?: anchor.web3.PublicKey;
    amount?: anchor.BN | number;
    owner?: User;
    srcTokenProgram?: anchor.web3.PublicKey;
  }) {
    const mint = srcMint ?? this.tokens[0];
    const makerUser = owner ?? this.alice;
    const approveAmount = amount ?? new anchor.BN(1_000_000_000);
    const delegate = findDelegateAuthority(program.programId);
    const ata = makerUser.atas[mint.toString()].address;
    const approveIx = splToken.createApproveInstruction(
      ata,
      delegate,
      makerUser.keypair.publicKey,
      BigInt(
        approveAmount instanceof anchor.BN
          ? approveAmount.toString()
          : approveAmount.toString()
      ),
      [],
      srcTokenProgram
    );
    const tx = new Transaction().add(approveIx);
    if (provider instanceof anchor.AnchorProvider) {
      await sendAndConfirmTransaction(provider.connection, tx, [
        payer,
        makerUser.keypair,
      ]);
    } else {
      tx.recentBlockhash = (await provider.getLatestBlockhash())[0];
      tx.sign(payer);
      tx.sign(makerUser.keypair);
      await provider.processTransaction(tx);
    }
  }

  /**
   * Maker-side order construction: build `OrderConfig`, compute the canonical
   * order hash, and sign it with the maker's key. Nothing lands on-chain
   * until a resolver calls `fill`.
   */
  createSignedOrder({
    programId,
    orderConfig,
    makerKeypair,
  }: {
    programId: PublicKey;
    orderConfig?: Partial<OrderConfig>;
    makerKeypair?: anchor.web3.Keypair;
  }): SignedOrder {
    const maker = makerKeypair ?? this.alice.keypair;
    const cfg = this.orderConfig(orderConfig, maker.publicKey);
    const orderHash = calculateOrderHash(programId, cfg);
    const signature = signOrderHash(orderHash, maker);
    const orderStatePda = findOrderStateAddress(
      programId,
      maker.publicKey,
      Buffer.from(orderHash)
    );
    const signed: SignedOrder = {
      orderConfig: cfg,
      orderHash,
      signature,
      orderStatePda,
      makerKeypair: maker,
    };
    this.orders.push(signed);
    return signed;
  }

  /**
   * Build the Anchor-accounts object for `fill` from a signed order + an
   * (optional) taker user. Falls back to Bob as taker.
   */
  buildAccountsDataForFill({
    program,
    signedOrder,
    taker,
    takerSrcAta,
    takerDstAta,
    protocolDstAcc = null,
    integratorDstAcc = null,
    srcTokenProgram = splToken.TOKEN_PROGRAM_ID,
    dstTokenProgram = splToken.TOKEN_PROGRAM_ID,
  }: {
    program: anchor.Program<ClearstoneFusion>;
    signedOrder: SignedOrder;
    taker?: User;
    takerSrcAta?: PublicKey;
    takerDstAta?: PublicKey;
    protocolDstAcc?: PublicKey | null;
    integratorDstAcc?: PublicKey | null;
    srcTokenProgram?: PublicKey;
    dstTokenProgram?: PublicKey;
  }): any {
    const takerUser = taker ?? this.bob;
    const maker = signedOrder.makerKeypair.publicKey;
    const srcMint = signedOrder.orderConfig.srcMint!;
    const dstMint = signedOrder.orderConfig.dstMint!;
    return {
      taker: takerUser.keypair.publicKey,
      maker,
      makerReceiver: signedOrder.orderConfig.receiver,
      srcMint,
      dstMint,
      makerSrcAta: this.alice.atas[srcMint.toString()].address,
      takerSrcAta: takerSrcAta ?? takerUser.atas[srcMint.toString()].address,
      makerDstAta: this.alice.atas[dstMint.toString()].address,
      takerDstAta: takerDstAta ?? takerUser.atas[dstMint.toString()].address,
      protocolDstAcc,
      integratorDstAcc,
      orderState: signedOrder.orderStatePda,
      delegateAuthority: findDelegateAuthority(program.programId),
      srcTokenProgram,
      dstTokenProgram,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    };
  }

  /**
   * Convenience: build `[ed25519_verify_ix, fill_ix]` ready to submit.
   */
  async buildFillTx({
    program,
    signedOrder,
    amount,
    taker,
    merkleProof = null,
    extraAccounts = {},
  }: {
    program: anchor.Program<ClearstoneFusion>;
    signedOrder: SignedOrder;
    amount: anchor.BN;
    taker?: User;
    merkleProof?: number[][] | null;
    extraAccounts?: Record<string, any>;
  }): Promise<{ ixs: TransactionInstruction[]; signers: anchor.web3.Keypair[] }> {
    const verifyIx = buildEd25519VerifyIx(
      signedOrder.makerKeypair.publicKey,
      signedOrder.orderHash,
      signedOrder.signature
    );
    const takerUser = taker ?? this.bob;
    const accounts = {
      ...this.buildAccountsDataForFill({ program, signedOrder, taker: takerUser }),
      ...extraAccounts,
    };
    const fillIx = await program.methods
      .fill(signedOrder.orderConfig, amount, merkleProof)
      .accountsPartial(accounts)
      .instruction();
    return { ixs: [verifyIx, fillIx], signers: [takerUser.keypair] };
  }

  orderConfig(
    params: Partial<OrderConfig> = {},
    makerPubkey?: PublicKey
  ): OrderConfig {
    const definedParams = Object.fromEntries(
      Object.entries(params).filter(([_, v]) => v !== undefined)
    );
    let fee: any;
    if (definedParams.fee) {
      fee = Object.fromEntries(
        Object.entries(definedParams.fee).filter(([_, v]) => v !== undefined)
      );
    }
    const result = {
      id: this.order_id++,
      srcAmount: this.defaultSrcAmount,
      minDstAmount: this.defaultDstAmount,
      estimatedDstAmount: this.defaultDstAmount,
      expirationTime: this.defaultExpirationTime,
      dstAssetIsNative: false,
      receiver: makerPubkey ?? this.alice.keypair.publicKey,
      dutchAuctionData: this.auction,
      resolverPolicy: permissionlessPolicy(),
      srcMint: this.tokens[0],
      dstMint: this.tokens[1],
      ...definedParams,
      fee: {
        protocolDstAcc: null,
        integratorDstAcc: null,
        protocolFee: 0,
        integratorFee: 0,
        surplusPercentage: 0,
        ...(fee ?? {}),
      },
    };
    return result;
  }
}

let tokensCounter = 0;
export async function createTokens(
  num: number,
  provider: anchor.AnchorProvider | BanksClient,
  payer: anchor.web3.Keypair,
  programId = splToken.TOKEN_PROGRAM_ID
): Promise<Array<anchor.web3.PublicKey>> {
  let tokens: Array<anchor.web3.PublicKey> = [];
  const [tokenLibrary, connection, extraArgs] =
    provider instanceof anchor.AnchorProvider
      ? [splToken, provider.connection, [undefined, programId]]
      : [splBankrunToken, provider, [programId]];

  for (let i = 0; i < num; ++i, ++tokensCounter) {
    const keypair = anchor.web3.Keypair.fromSeed(
      new Uint8Array(32).fill(tokensCounter + 101)
    );
    tokens.push(
      await tokenLibrary.createMint(
        connection,
        payer,
        payer.publicKey,
        null,
        6,
        keypair,
        ...extraArgs
      )
    );
  }
  return tokens;
}

let usersCounter = 0;
async function createUsers(
  num: number,
  tokens: Array<anchor.web3.PublicKey>,
  provider: anchor.AnchorProvider | BanksClient,
  payer: anchor.web3.Keypair
): Promise<Array<User>> {
  let usersKeypairs: Array<anchor.web3.Keypair> = [];
  for (let i = 0; i < num; ++i, ++usersCounter) {
    const keypair = anchor.web3.Keypair.fromSeed(
      new Uint8Array(32).fill(usersCounter)
    );
    usersKeypairs.push(keypair);
    if (provider instanceof anchor.AnchorProvider) {
      await provider.connection.requestAirdrop(
        keypair.publicKey,
        1 * LAMPORTS_PER_SOL
      );
    }
  }
  return await createAtasUsers(usersKeypairs, tokens, provider, payer);
}

export async function createAtasUsers(
  usersKeypairs: Array<anchor.web3.Keypair>,
  tokens: Array<anchor.web3.PublicKey>,
  provider: anchor.AnchorProvider | BanksClient,
  payer: anchor.web3.Keypair,
  tokenProgram = splToken.TOKEN_PROGRAM_ID
): Promise<Array<User>> {
  let users: Array<User> = [];
  const [tokenLibrary, connection, extraArgs] =
    provider instanceof anchor.AnchorProvider
      ? [splToken, provider.connection, [undefined, tokenProgram]]
      : [splBankrunToken, provider, [tokenProgram]];

  for (let i = 0; i < usersKeypairs.length; ++i) {
    const keypair = usersKeypairs[i];
    const atas = {};
    for (const token of tokens) {
      const pubkey = await tokenLibrary.createAssociatedTokenAccount(
        connection,
        payer,
        token,
        keypair.publicKey,
        ...extraArgs
      );
      atas[token.toString()] = await tokenLibrary.getAccount(
        connection,
        pubkey,
        undefined,
        tokenProgram
      );
    }
    users.push({ keypair, atas });
  }
  return users;
}

export async function mintTokens(
  token: anchor.web3.PublicKey,
  user: User,
  amount: number,
  provider: anchor.AnchorProvider | BanksClient,
  payer: anchor.web3.Keypair,
  tokenProgram = splToken.TOKEN_PROGRAM_ID
) {
  const [tokenLibrary, connection, extraArgs] =
    provider instanceof anchor.AnchorProvider
      ? [splToken, provider.connection, [undefined, tokenProgram]]
      : [splBankrunToken, provider, [tokenProgram]];

  await tokenLibrary.mintTo(
    connection,
    payer,
    token,
    user.atas[token.toString()].address,
    payer,
    amount,
    [],
    ...extraArgs
  );
}

export async function setCurrentTime(
  context: ProgramTestContext,
  time: number
): Promise<void> {
  const currentClock = await context.banksClient.getClock();
  context.setClock(
    new Clock(
      currentClock.slot,
      currentClock.epochStartTimestamp,
      currentClock.epoch,
      currentClock.leaderScheduleEpoch,
      BigInt(time)
    )
  );
}

type TxInfoInstruction = {
  data: string | Uint8Array;
  accountsIndexes: number[];
};

class TxInfo {
  label: string;
  instructions: TxInfoInstruction[];
  length: number;
  computeUnits: number;

  constructor({
    label = "",
    instructions = [],
    length = 0,
    computeUnits = 0,
  }: {
    label: string;
    instructions: TxInfoInstruction[];
    length: number;
    computeUnits: number;
  }) {
    this.label = label;
    this.instructions = instructions;
    this.length = length;
    this.computeUnits = computeUnits;
  }

  toString() {
    return `Tx ${this.label}: ${this.length} bytes, ${this.computeUnits} compute units\n${this.instructions
      .map(
        (ix, i) =>
          `\tinst ${i}: ${ix.data.length} bytes + ${ix.accountsIndexes.length} accounts \n`
      )
      .join("")}`;
  }
}

export async function printTxCosts(
  label: string,
  txSignature: TransactionSignature,
  connection: anchor.web3.Connection
) {
  await waitForNewBlock(connection, 1);
  const tx = await connection.getTransaction(txSignature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  const serializedMessage = tx.transaction.message.serialize();
  const signaturesSize = tx.transaction.signatures.length * 64;
  const totalSize = serializedMessage.length + 1 + signaturesSize;

  const txInfo = new TxInfo({
    label,
    length: totalSize,
    computeUnits: tx.meta.computeUnitsConsumed,
    instructions: [],
  });

  if (tx.transaction.message instanceof Message) {
    tx.transaction.message.instructions.forEach((ix) => {
      txInfo.instructions.push({
        data: bs58.decode(ix.data),
        accountsIndexes: ix.accounts,
      });
    });
  } else {
    tx.transaction.message.compiledInstructions.forEach((ix) => {
      txInfo.instructions.push({
        data: ix.data,
        accountsIndexes: ix.accountKeyIndexes,
      });
    });
  }

  console.log(txInfo.toString());
}

/**
 * Pull the Anchor error name out of a bankrun-surfaced transaction error.
 * Bankrun returns `custom program error: 0x….` strings with no name; we look
 * the code up in the program's IDL.
 */
export function errorNameFromBankrun(
  program: anchor.Program<ClearstoneFusion>,
  err: unknown
): string | null {
  const msg = typeof err === "string" ? err : (err as any)?.message ?? String(err);
  const m = msg.match(/custom program error: (0x[0-9a-fA-F]+)/);
  if (!m) return null;
  const code = parseInt(m[1], 16);
  const entry = (program.idl as any).errors?.find((e: any) => e.code === code);
  return entry?.name ?? null;
}

/**
 * Await `promise`, assert it rejects, and verify the underlying program
 * error matches `expectedName`. Works for both AnchorError-wrapped and
 * raw-bankrun rejections.
 */
/**
 * Await `promise`, assert it rejects, and verify the underlying program
 * error matches `expectedName` (case-insensitive — the Anchor IDL emits
 * camelCase names while the Rust enum uses PascalCase).
 */
export async function expectProgramError(
  program: anchor.Program<ClearstoneFusion>,
  promise: Promise<any>,
  expectedName: string
): Promise<void> {
  const norm = (s: string) => s.toLowerCase();
  try {
    await promise;
  } catch (e: any) {
    const anchorName = e?.error?.errorCode?.code;
    if (anchorName && norm(anchorName) === norm(expectedName)) return;
    const bankrunName = errorNameFromBankrun(program, e);
    if (bankrunName && norm(bankrunName) === norm(expectedName)) return;
    throw new Error(
      `expected program error ${expectedName}, got ${
        anchorName ?? bankrunName ?? "(unrecognized)"
      }: ${e?.message ?? e}`
    );
  }
  throw new Error(`expected program error ${expectedName}, but promise resolved`);
}

export async function waitForNewBlock(
  connection: anchor.web3.Connection,
  targetHeight: number
): Promise<void> {
  return new Promise(async (resolve: any) => {
    const { lastValidBlockHeight } = await connection.getLatestBlockhash();
    const intervalId = setInterval(async () => {
      const { lastValidBlockHeight: newValidBlockHeight } =
        await connection.getLatestBlockhash();
      if (newValidBlockHeight > lastValidBlockHeight + targetHeight) {
        clearInterval(intervalId);
        resolve();
      }
    }, 1000);
  });
}
