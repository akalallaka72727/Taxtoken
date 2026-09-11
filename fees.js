import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  getTransferFeeAmount,
  createHarvestWithheldTokensToMintInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

const MAX_SOURCES_PER_TX = 20; // conservative batch size to stay under tx size limits

// Scans every token account for this mint and returns those holding withheld (unclaimed) tax.
export async function scanWithheldAccounts(connection, mintPubkey) {
  const accounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: mintPubkey.toBase58() } }],
  });

  const withheld = [];
  let total = 0n;

  for (const { pubkey, account } of accounts) {
    const unpacked = unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID);
    const feeAmount = getTransferFeeAmount(unpacked);
    if (feeAmount && feeAmount.withheldAmount > 0n) {
      withheld.push({ address: pubkey, amount: feeAmount.withheldAmount });
      total += feeAmount.withheldAmount;
    }
  }

  return { accounts: withheld, total };
}

// Step 1: harvest withheld fees from individual token accounts into the mint account.
// Step 2: withdraw the accumulated amount from the mint to the treasury wallet's ATA.
export async function harvestAndWithdraw(connection, payer, mintPubkey, withdrawAuthority) {
  const { accounts, total } = await scanWithheldAccounts(connection, mintPubkey);

  if (total === 0n) {
    return { harvested: 0n, signatures: [], claimedTo: null };
  }

  const signatures = [];

  // Harvest in batches (instruction accepts many source accounts at once, but keep tx size sane)
  for (let i = 0; i < accounts.length; i += MAX_SOURCES_PER_TX) {
    const batch = accounts.slice(i, i + MAX_SOURCES_PER_TX).map((a) => a.address);
    if (batch.length === 0) continue;

    const tx = new Transaction().add(
      createHarvestWithheldTokensToMintInstruction(mintPubkey, batch, TOKEN_2022_PROGRAM_ID)
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
    signatures.push(sig);
  }

  // Withdraw from mint to treasury (withdrawAuthority) ATA
  const treasuryAta = getAssociatedTokenAddressSync(mintPubkey, withdrawAuthority.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const withdrawTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      treasuryAta,
      withdrawAuthority.publicKey,
      mintPubkey,
      TOKEN_2022_PROGRAM_ID
    ),
    createWithdrawWithheldTokensFromMintInstruction(
      mintPubkey,
      treasuryAta,
      withdrawAuthority.publicKey,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );

  const withdrawSig = await sendAndConfirmTransaction(connection, withdrawTx, [payer, withdrawAuthority], {
    commitment: "confirmed",
  });
  signatures.push(withdrawSig);

  return { harvested: total, signatures, claimedTo: treasuryAta.toBase58() };
}
