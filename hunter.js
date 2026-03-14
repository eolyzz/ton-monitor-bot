const { ethers } = require("ethers");
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const readline = require('readline');

// --- 1. WORKER LOGIC (Runs on every CPU thread) ---
if (!isMainThread) {
    const { prefix, suffix } = workerData;
    
    while (true) {
        const wallet = ethers.Wallet.createRandom();
        const addr = wallet.address.toLowerCase();
        
        // Check 3 prefix (starts at index 2) and 4 suffix
        if (addr.substring(2, 5) === prefix && addr.slice(-4) === suffix) {
            parentPort.postMessage({
                address: wallet.address,
                privateKey: wallet.privateKey
            });
            break; 
        }
    }
    return;
}

// --- 2. MAIN THREAD (Terminal Interface) ---
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
}); 

console.log(`🚀 Multi-Threaded Hunter Loaded (${os.cpus().length} CPU Cores detected)`);

rl.question('🎯 Paste the target "Dust" address: ', (target) => {
    const cleanTarget = target.toLowerCase();
    
    // Validate address length
    if (!ethers.isAddress(cleanTarget)) {
        console.log("❌ Invalid Ethereum address.");
        process.exit();
    }

    const prefix = cleanTarget.substring(2, 5);
    const suffix = cleanTarget.slice(-4);

    console.log(`\n🔎 Searching for pattern: 0x${prefix}...${suffix}`);
    console.log(`⚡ Using all cores. This may take a few minutes...\n`);

    const startTime = Date.now();
    let found = false;

    // Spawn a worker for every core on your i7
    os.cpus().forEach(() => {
        const worker = new Worker(__filename, { 
            workerData: { prefix, suffix } 
        });

        worker.on('message', (result) => {
            if (found) return; // Prevent double printing
            found = true;
            
            const timeTaken = (Date.now() - startTime) / 1000;
            
            console.log(`\n✅ MATCH FOUND!`);
            console.log(`──────────────────────────────────────────`);
            console.log(`✨ Vanity Address: ${result.address}`);
            console.log(`🔑 Private Key:    ${result.privateKey}`);
            console.log(`⏱️  Time Taken:     ${timeTaken} seconds`);
            console.log(`──────────────────────────────────────────`);
            
            process.exit(); // Close everything
        });
    });
});