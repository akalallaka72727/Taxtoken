import "dotenv/config";
import { Telegraf } from "telegraf";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { uploadImageToPinata, uploadMetadataToPinata } from "./ipfs.js";
import { createTaxToken } from "./token.js";
import { harvestAndWithdraw, scanWithheldAccounts } from "./fees.js";
import { addToken, listTokens, getToken } from "./registry.js";
import { getSession, resetSession, setStep } from "./session.js";

// ── ENV validation ────────────────────────────────────────────────────────────
const REQUIRED_ENV = ["BOT_TOKEN", "SOLANA_RPC", "PAYER_PRIVATE_KEY", "PINATA_JWT"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`Missing env var: ${key}`);
}

// ── Solana setup ──────────────────────────────────────────────────────────────
const connection = new Connection(process.env.SOLANA_RPC, "confirmed");
const payer = Keypair.fromSecretKey(bs58.decode(process.env.PAYER_PRIVATE_KEY));

// If separate withdraw authority is set, use it; otherwise payer doubles as authority
const withdrawAuthority = process.env.WITHDRAW_PRIVATE_KEY
  ? Keypair.fromSecretKey(bs58.decode(process.env.WITHDRAW_PRIVATE_KEY))
  : payer;

// ── Bot setup ─────────────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);

// Allowed user IDs (optional). Set ALLOWED_USERS=123456,789012 in env to restrict.
const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? new Set(process.env.ALLOWED_USERS.split(",").map((s) => Number(s.trim())))
  : null;

function isAllowed(ctx) {
  if (!ALLOWED_USERS) return true;
  return ALLOWED_USERS.has(ctx.from?.id);
}

function guard(ctx, next) {
  if (!isAllowed(ctx)) return ctx.reply("⛔ Unauthorized.");
  return next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatLamports(lamports) {
  return (Number(lamports) / 1e9).toFixed(6) + " SOL";
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── /start ────────────────────────────────────────────────────────────────────
bot.start(guard, (ctx) => {
  resetSession(ctx.chat.id);
  ctx.replyWithHTML(
    `👋 <b>Token-2022 Tax Bot</b>\n\n` +
    `Buat token SPL Token-2022 dengan <b>transfer fee (tax)</b> di Solana.\n\n` +
    `<b>Commands:</b>\n` +
    `/create — Buat token baru\n` +
    `/list — Daftar token yang sudah dibuat\n` +
    `/harvest &lt;mint&gt; — Harvest &amp; withdraw fee\n` +
    `/fees &lt;mint&gt; — Cek fee yang terkumpul\n` +
    `/cancel — Batalkan proses\n` +
    `/help — Bantuan`
  );
});

// ── /help ─────────────────────────────────────────────────────────────────────
bot.help(guard, (ctx) => {
  ctx.replyWithHTML(
    `<b>📖 Panduan Token-2022 Tax Bot</b>\n\n` +
    `<b>/create</b> — Wizard interaktif untuk buat token baru dengan tax extension.\n` +
    `<b>/list</b> — Tampilkan semua token yang pernah dibuat.\n` +
    `<b>/harvest</b> <code>&lt;mint&gt;</code> — Harvest withheld fees dari semua holder, lalu withdraw ke treasury.\n` +
    `<b>/fees</b> <code>&lt;mint&gt;</code> — Scan dan tampilkan berapa fee yang belum di-harvest.\n` +
    `<b>/cancel</b> — Batalkan wizard yang sedang berjalan.\n\n` +
    `<b>Env yang dibutuhkan:</b>\n` +
    `• <code>BOT_TOKEN</code> — Telegram bot token\n` +
    `• <code>SOLANA_RPC</code> — RPC endpoint\n` +
    `• <code>PAYER_PRIVATE_KEY</code> — Private key bs58 untuk bayar fee\n` +
    `• <code>PINATA_JWT</code> — JWT untuk upload metadata ke IPFS\n` +
    `• <code>WITHDRAW_PRIVATE_KEY</code> — (opsional) Private key untuk withdraw tax`
  );
});

// ── /cancel ───────────────────────────────────────────────────────────────────
bot.command("cancel", guard, (ctx) => {
  resetSession(ctx.chat.id);
  ctx.reply("❌ Dibatalkan. Kirim /start untuk mulai lagi.");
});

// ── /list ─────────────────────────────────────────────────────────────────────
bot.command("list", guard, (ctx) => {
  const tokens = listTokens();
  if (!tokens.length) return ctx.reply("Belum ada token yang dibuat. Gunakan /create.");

  const lines = tokens.map((t, i) =>
    `<b>${i + 1}. ${escapeHtml(t.name)} (${escapeHtml(t.symbol)})</b>\n` +
    `   Mint: <code>${t.mint}</code>\n` +
    `   Tax: ${t.taxBps / 100}% | Max: ${t.maxFee} token\n` +
    `   Supply: ${t.supply.toLocaleString()} | Decimals: ${t.decimals}\n` +
    `   Dibuat: ${new Date(t.createdAt).toLocaleString("id-ID")}`
  );

  ctx.replyWithHTML(`<b>📋 Token Kamu:</b>\n\n` + lines.join("\n\n"));
});

// ── /fees <mint> ──────────────────────────────────────────────────────────────
bot.command("fees", guard, async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  if (!args[0]) return ctx.reply("Usage: /fees <mint_address>");

  let mintPubkey;
  try {
    mintPubkey = new PublicKey(args[0]);
  } catch {
    return ctx.reply("❌ Alamat mint tidak valid.");
  }

  const msg = await ctx.reply("🔍 Scanning withheld fees...");

  try {
    const { accounts, total } = await scanWithheldAccounts(connection, mintPubkey);
    const tokenInfo = getToken(args[0]);
    const decimals = tokenInfo?.decimals ?? 6;
    const humanTotal = (Number(total) / 10 ** decimals).toFixed(decimals);

    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `💰 <b>Withheld Fees</b>\n\n` +
      `Mint: <code>${args[0]}</code>\n` +
      `Total: <b>${humanTotal} ${escapeHtml(tokenInfo?.symbol ?? "token")}</b>\n` +
      `Dari ${accounts.length} akun`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `❌ Error: ${escapeHtml(err.message)}`
    );
  }
});

// ── /harvest <mint> ───────────────────────────────────────────────────────────
bot.command("harvest", guard, async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  if (!args[0]) return ctx.reply("Usage: /harvest <mint_address>");

  let mintPubkey;
  try {
    mintPubkey = new PublicKey(args[0]);
  } catch {
    return ctx.reply("❌ Alamat mint tidak valid.");
  }

  const msg = await ctx.reply("⏳ Harvesting & withdrawing fees...");

  try {
    const result = await harvestAndWithdraw(connection, payer, mintPubkey, withdrawAuthority);
    const tokenInfo = getToken(args[0]);
    const decimals = tokenInfo?.decimals ?? 6;

    if (result.harvested === 0n) {
      return ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        `ℹ️ Tidak ada withheld fees untuk di-harvest.`
      );
    }

    const humanAmount = (Number(result.harvested) / 10 ** decimals).toFixed(decimals);
    const sigLines = result.signatures.map((s) => `• <a href="https://solscan.io/tx/${s}">${s.slice(0, 20)}…</a>`).join("\n");

    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `✅ <b>Harvest Berhasil!</b>\n\n` +
      `Jumlah: <b>${humanAmount} ${escapeHtml(tokenInfo?.symbol ?? "token")}</b>\n` +
      `Treasury ATA: <code>${result.claimedTo}</code>\n\n` +
      `<b>Transaksi:</b>\n${sigLines}`,
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `❌ Harvest gagal: ${escapeHtml(err.message)}`
    );
  }
});

// ── /create wizard ────────────────────────────────────────────────────────────
const STEPS = [
  { key: "name",        prompt: "1️⃣ Nama token? (contoh: MyToken)" },
  { key: "symbol",      prompt: "2️⃣ Symbol/ticker? (contoh: MTK, maks 10 huruf)" },
  { key: "description", prompt: "3️⃣ Deskripsi token?" },
  { key: "decimals",    prompt: "4️⃣ Decimals? (0-9, biasanya 6 atau 9)" },
  { key: "supply",      prompt: "5️⃣ Total supply? (angka, contoh: 1000000)" },
  { key: "taxBps",      prompt: "6️⃣ Tax dalam basis points? (100 = 1%, maks 10000 = 100%)" },
  { key: "maxFee",      prompt: "7️⃣ Max fee per transfer? (dalam token, contoh: 100)" },
  { key: "image",       prompt: "8️⃣ Kirim foto/gambar untuk token logo (atau ketik 'skip' untuk tanpa gambar)" },
];

bot.command("create", guard, (ctx) => {
  resetSession(ctx.chat.id);
  const session = setStep(ctx.chat.id, "name");
  ctx.replyWithHTML(
    `🪙 <b>Buat Token Baru</b>\n\n` +
    `Wizard akan pandumu membuat SPL Token-2022 dengan transfer fee.\n\n` +
    STEPS[0].prompt
  );
});

// Process wizard step for text messages
bot.on("text", guard, async (ctx) => {
  const session = getSession(ctx.chat.id);
  if (!session.step) return; // not in wizard

  const text = ctx.message.text.trim();

  // Cancel shortcut
  if (text.toLowerCase() === "/cancel") {
    resetSession(ctx.chat.id);
    return ctx.reply("❌ Dibatalkan.");
  }

  const stepConfig = STEPS.find((s) => s.key === session.step);
  if (!stepConfig) return;

  // Validate input
  let value;
  switch (session.step) {
    case "name":
      if (!text || text.length > 50) return ctx.reply("❌ Nama harus 1-50 karakter.");
      value = text;
      break;
    case "symbol":
      if (!text || text.length > 10) return ctx.reply("❌ Symbol max 10 karakter.");
      value = text.toUpperCase();
      break;
    case "description":
      value = text;
      break;
    case "decimals": {
      const d = parseInt(text);
      if (isNaN(d) || d < 0 || d > 9) return ctx.reply("❌ Decimals harus angka 0-9.");
      value = d;
      break;
    }
    case "supply": {
      const s = parseInt(text.replace(/,/g, ""));
      if (isNaN(s) || s <= 0) return ctx.reply("❌ Supply harus angka positif.");
      value = s;
      break;
    }
    case "taxBps": {
      const bps = parseInt(text);
      if (isNaN(bps) || bps < 0 || bps > 10000) return ctx.reply("❌ Tax harus 0-10000 basis points.");
      value = bps;
      break;
    }
    case "maxFee": {
      const mf = parseFloat(text);
      if (isNaN(mf) || mf < 0) return ctx.reply("❌ Max fee harus angka positif.");
      value = mf;
      break;
    }
    case "image":
      if (text.toLowerCase() === "skip") {
        value = null;
      } else {
        return ctx.reply("❌ Kirim gambar (foto) atau ketik 'skip'.");
      }
      break;
    default:
      return;
  }

  session.data[session.step] = value;

  // Advance to next step
  const currentIdx = STEPS.findIndex((s) => s.key === session.step);
  const nextStep = STEPS[currentIdx + 1];

  if (nextStep) {
    setStep(ctx.chat.id, nextStep.key);
    return ctx.reply(nextStep.prompt);
  }

  // All steps done — deploy!
  await deployToken(ctx, session.data);
});

// Handle photo upload in wizard
bot.on("photo", guard, async (ctx) => {
  const session = getSession(ctx.chat.id);
  if (session.step !== "image") {
    return ctx.reply("Gunakan /create untuk mulai buat token.");
  }

  const photo = ctx.message.photo[ctx.message.photo.length - 1]; // highest res
  const fileLink = await ctx.telegram.getFileLink(photo.file_id);

  const msg = await ctx.reply("⬆️ Mengupload gambar ke IPFS...");

  try {
    const response = await fetch(fileLink.href);
    const buffer = Buffer.from(await response.arrayBuffer());
    const imageUri = await uploadImageToPinata(buffer, `${session.data.symbol || "token"}-logo.jpg`);
    session.data.image = imageUri;

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, "✅ Gambar terupload!");
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `⚠️ Upload gambar gagal: ${err.message}. Lanjut tanpa gambar.`);
    session.data.image = null;
  }

  // Advance (no more steps after image)
  setStep(ctx.chat.id, null);
  await deployToken(ctx, session.data);
});

// ── Deploy token ──────────────────────────────────────────────────────────────
async function deployToken(ctx, data) {
  resetSession(ctx.chat.id);

  const summary =
    `🔍 <b>Konfirmasi Token</b>\n\n` +
    `Nama: <b>${escapeHtml(data.name)}</b>\n` +
    `Symbol: <b>${escapeHtml(data.symbol)}</b>\n` +
    `Deskripsi: ${escapeHtml(data.description)}\n` +
    `Decimals: ${data.decimals}\n` +
    `Supply: ${Number(data.supply).toLocaleString()}\n` +
    `Tax: ${data.taxBps / 100}%\n` +
    `Max Fee: ${data.maxFee} token\n` +
    `Logo: ${data.image ? "✅" : "❌ (tanpa gambar)"}\n\n` +
    `⏳ Membuat token di Solana...`;

  const msg = await ctx.replyWithHTML(summary);

  try {
    // Upload metadata to IPFS
    let metadataUri = "";
    try {
      metadataUri = await uploadMetadataToPinata({
        name: data.name,
        symbol: data.symbol,
        description: data.description,
        imageUri: data.image || "",
      });
    } catch (err) {
      await ctx.reply(`⚠️ Upload metadata gagal: ${err.message}. Menggunakan URI kosong.`);
      metadataUri = "";
    }

    // Create token on-chain
    const result = await createTaxToken(connection, payer, payer, withdrawAuthority.publicKey, {
      name: data.name,
      symbol: data.symbol,
      uri: metadataUri,
      decimals: data.decimals,
      supply: data.supply,
      taxBps: data.taxBps,
      maxFee: data.maxFee,
    });

    // Save to registry
    addToken({
      mint: result.mint,
      name: data.name,
      symbol: data.symbol,
      decimals: data.decimals,
      supply: data.supply,
      taxBps: data.taxBps,
      maxFee: data.maxFee,
      metadataUri,
      signature: result.signature,
      destinationAta: result.destinationAta,
    });

    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `🎉 <b>Token Berhasil Dibuat!</b>\n\n` +
      `<b>${escapeHtml(data.name)} (${escapeHtml(data.symbol)})</b>\n\n` +
      `Mint: <code>${result.mint}</code>\n` +
      `ATA: <code>${result.destinationAta}</code>\n` +
      `Metadata IPFS: ${metadataUri ? `<a href="${metadataUri}">link</a>` : "—"}\n\n` +
      `Solscan: <a href="https://solscan.io/token/${result.mint}">Lihat di Solscan</a>\n` +
      `TX: <a href="https://solscan.io/tx/${result.signature}">${result.signature.slice(0, 20)}…</a>\n\n` +
      `Gunakan /harvest ${result.mint} untuk klaim tax fees.`,
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  } catch (err) {
    console.error("Deploy error:", err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `❌ <b>Gagal buat token!</b>\n\n${escapeHtml(err.message)}`,
      { parse_mode: "HTML" }
    );
  }
}

// ── Error handler ─────────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  ctx.reply("❌ Terjadi error internal. Coba lagi nanti.").catch(() => {});
});

// ── Launch ────────────────────────────────────────────────────────────────────
console.log("🤖 Bot starting...");
bot.launch({ dropPendingUpdates: true });
console.log("✅ Bot running!");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
