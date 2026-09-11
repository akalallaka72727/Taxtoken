import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeMetadataPointerInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getMintLen,
  getAssociatedTokenAddressSync,
  LENGTH_SIZE,
  TYPE_SIZE,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";

/**
 * Creates a new SPL Token-2022 mint with:
 *  - TransferFeeConfig extension (the "tax")
 *  - MetadataPointer + on-mint TokenMetadata extension (points to itself, uri from IPFS)
 * Then mints the full supply to the destination wallet (mintAuthority's wallet by default).
 *
 * @param {Connection} connection
 * @param {Keypair} payer - pays fees, becomes destination for minted supply
 * @param {Keypair} mintAuthority - can mint further / is set as mint authority (revoke later if you want fixed supply)
 * @param {PublicKey} withdrawWithheldAuthority - wallet allowed to harvest+withdraw tax
 * @param {object} params - { name, symbol, uri, decimals, supply, taxBps, maxFee }
 */
export async function createTaxToken(connection, payer, mintAuthority, withdrawWithheldAuthority, params) {
  const { name, symbol, uri, decimals, supply, taxBps, maxFee } = params;

  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  const metadata = {
    mint,
    name,
    symbol,
    uri,
    additionalMetadata: [],
  };

  const extensions = [ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer];
  const mintLen = getMintLen(extensions);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;

  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);

  const maxFeeBaseUnits = BigInt(Math.floor(maxFee * 10 ** decimals));

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferFeeConfigInstruction(
      mint,
      mintAuthority.publicKey, // transferFeeConfigAuthority (can update bps later)
      withdrawWithheldAuthority, // withdrawWithheldAuthority (can claim tax)
      taxBps,
      maxFeeBaseUnits,
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMetadataPointerInstruction(
      mint,
      mintAuthority.publicKey,
      mint, // metadata stored on the mint itself
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(mint, decimals, mintAuthority.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      updateAuthority: mintAuthority.publicKey,
      mint,
      mintAuthority: mintAuthority.publicKey,
      name,
      symbol,
      uri,
    })
  );

  const destinationAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const supplyBaseUnits = BigInt(supply) * BigInt(10 ** decimals);

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      destinationAta,
      payer.publicKey,
      mint,
      TOKEN_2022_PROGRAM_ID
    ),
    createMintToInstruction(mint, destinationAta, mintAuthority.publicKey, supplyBaseUnits, [], TOKEN_2022_PROGRAM_ID)
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [payer, mintKeypair, mintAuthority], {
    commitment: "confirmed",
  });

  return { mint: mint.toBase58(), signature: sig, destinationAta: destinationAta.toBase58() };
}
