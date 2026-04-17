import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
const fs = require("fs");

import FUSION_IDL from "../../target/idl/clearstone_fusion.json";
import { ClearstoneFusion } from "../../target/types/clearstone_fusion";
import {
  calculateOrderHash,
  findEscrowAddress,
  getClusterUrlEnv,
  getTokenDecimals,
  loadKeypairFromFile,
  OrderConfig,
  prompt_,
} from "../utils";

async function fill(
  connection: Connection,
  program: Program<ClearstoneFusion>,
  takerKeypair: Keypair,
  maker: PublicKey,
  amount: number,
  orderConfig: OrderConfig,
  merkleProof: number[][] | null = null
): Promise<void> {
  const orderHash = calculateOrderHash(orderConfig);
  let taker = takerKeypair.publicKey;

  const escrow = findEscrowAddress(
    program.programId,
    maker,
    Buffer.from(orderHash)
  );
  const escrowSrcAta = await splToken.getAssociatedTokenAddress(
    orderConfig.srcMint,
    escrow,
    true
  );

  const takerSrcAta = await splToken.getAssociatedTokenAddress(
    orderConfig.srcMint,
    taker
  );

  const takerDstAta = await splToken.getAssociatedTokenAddress(
    orderConfig.dstMint,
    takerKeypair.publicKey
  );

  const makerDstAta = await splToken.getAssociatedTokenAddress(
    orderConfig.dstMint,
    maker
  );

  const srcMintDecimals = await getTokenDecimals(
    connection,
    orderConfig.srcMint
  );

  const fillIx = await program.methods
    .fill(
      orderConfig,
      new BN(amount * Math.pow(10, srcMintDecimals)),
      merkleProof
    )
    .accountsPartial({
      taker,
      maker,
      makerReceiver: orderConfig.receiver,
      srcMint: orderConfig.srcMint,
      dstMint: orderConfig.dstMint,
      escrow,
      escrowSrcAta,
      takerSrcAta,
      takerDstAta,
      makerDstAta,
      protocolDstAcc: orderConfig.fee.protocolDstAcc,
      integratorDstAcc: orderConfig.fee.integratorDstAcc,
      srcTokenProgram: splToken.TOKEN_PROGRAM_ID,
      dstTokenProgram: splToken.TOKEN_PROGRAM_ID,
    })
    .signers([takerKeypair])
    .instruction();

  const tx = new Transaction().add(fillIx);

  const signature = await sendAndConfirmTransaction(connection, tx, [
    takerKeypair,
  ]);
  console.log(`Transaction signature ${signature}`);
}

async function main() {
  const clusterUrl = getClusterUrlEnv();
  const orderFilePath = prompt_("order", "Enter order config file path: ");
  const maker = new PublicKey(prompt_("maker-key", "Enter maker public key: "));

  const orderConfigJson = JSON.parse(fs.readFileSync(orderFilePath));

  const orderConfig: OrderConfig = {
    ...orderConfigJson,
    srcAmount: new BN(orderConfigJson.srcAmount, "hex"),
    minDstAmount: new BN(orderConfigJson.minDstAmount, "hex"),
    estimatedDstAmount: new BN(orderConfigJson.estimatedDstAmount, "hex"),
    srcMint: new PublicKey(orderConfigJson.srcMint),
    dstMint: new PublicKey(orderConfigJson.dstMint),
    receiver: new PublicKey(orderConfigJson.receiver),
  };

  const takerKeypairPath = prompt_("taker-kp", "Enter taker keypair path");
  const takerKeypair = await loadKeypairFromFile(takerKeypairPath);
  const amount = Number(prompt_("amount", "Enter fill amount: "));

  const connection = new Connection(clusterUrl, "confirmed");
  const fusionSwap = new Program<ClearstoneFusion>(FUSION_IDL, { connection });

  try {
    const orderHash = calculateOrderHash(orderConfig);

    const escrowAddr = findEscrowAddress(
      fusionSwap.programId,
      maker,
      Buffer.from(orderHash)
    );

    const escrowSrcAtaAddr = await splToken.getAssociatedTokenAddress(
      orderConfig.srcMint,
      escrowAddr,
      true
    );
    console.log("Escrow address:" + escrowAddr.toString());
    console.log("Escrow src ata:" + escrowSrcAtaAddr.toString());
    console.log(
      `Order hash hex in fill: ${Buffer.from(orderHash).toString("hex")}`
    );

    await splToken.getAccount(connection, escrowSrcAtaAddr);
    console.log(`Order exists`);
  } catch (e) {
    console.error(
      `Escrow with given order config and maker = ${maker.toString()} does not exist`
    );
    return;
  }
  orderConfig.fee.maxCancellationPremium = new BN(
    orderConfigJson.fee.maxCancellationPremium,
    "hex"
  );

  await fill(
    connection,
    fusionSwap,
    takerKeypair,
    maker,
    amount,
    orderConfig
  );
}

main();
