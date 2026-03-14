// gpu_hunter_updated.js
// Ethereum vanity matcher using profanity3 with auto-save

const { spawn } = require("child_process");
const readline = require("readline");
const { ethers } = require("ethers");
const fs = require("fs");

// ─────────────────────────────
// CONFIGURATION
// ─────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const PROFANITY_EXE = ".\\profanity3.exe";

// 128 hex chars from UNCOMPRESSED public key (without 0x04)
const SEED_PUBKEY =
"c5f3f912e73956078d8c7eb4a626827158681c1be38d23c3bc4150395457d89a16a0607a4eb63ad8428297b87b4d995bad674b442c093ddc2d5d7b22e701b544";

// Skip problematic GPUs
const SKIP_DEVICES = ["-s","1","-s","2","-s","3"];

// Kernel stability flags
const EXTRA_FLAGS = [
  "-n",          // disable kernel cache
  "-w","32",     // smaller work size
  "-W","4096"    // max work limit
];

const PREFIX_LENGTH = 5;
const SUFFIX_LENGTH = 4;
const ADDRESS_LENGTH = 40;

// Output files
const RESULT_FILE = "results.txt";
const FULL_LOG_FILE = "full_log.txt";

// ─────────────────────────────
// START SCRIPT
// ─────────────────────────────

console.log("GPU Hunter - Ethereum vanity matcher");
console.log("Using profanity3 + GPU acceleration\n");

rl.question("Paste target Ethereum address (0x...): ", (input) => {

  const target = input.trim();

  if (!ethers.isAddress(target)) {
    console.log("\n❌ Invalid Ethereum address");
    rl.close();
    return;
  }

  const prefix = target.substring(2, 2 + PREFIX_LENGTH).toLowerCase();
  const suffix = target.slice(-SUFFIX_LENGTH).toLowerCase();
  const wildcardLength = ADDRESS_LENGTH - PREFIX_LENGTH - SUFFIX_LENGTH;

  const pattern = prefix + "X".repeat(wildcardLength) + suffix;

  console.log("\nTarget pattern");
  console.log("Prefix :", prefix);
  console.log("Suffix :", suffix);
  console.log("Wildcard length:", wildcardLength);
  console.log("Pattern:", pattern);

  if (!SEED_PUBKEY || SEED_PUBKEY.length !== 128 || !/^[0-9a-fA-F]{128}$/.test(SEED_PUBKEY)) {
    console.log("\n❌ Invalid SEED_PUBKEY");
    rl.close();
    return;
  }

  const args = [
    "--matching",
    pattern,
    "-z",
    SEED_PUBKEY,
    ...EXTRA_FLAGS,
    ...SKIP_DEVICES
  ];

  console.log("\nRunning command:\n");
  console.log(`${PROFANITY_EXE} ${args.join(" ")}`);
  console.log("\nSearching...\n");

  const start = Date.now();
  let found = false;

  const child = spawn(PROFANITY_EXE, args);

  child.stdout.on("data", (data) => {
    const text = data.toString();

    // 1️⃣ Print to console live
    process.stdout.write(text);

    // 2️⃣ Save full log
    fs.appendFileSync(FULL_LOG_FILE, text);

    // 3️⃣ Check for private key / address hits
    const lower = text.toLowerCase();
    if (lower.includes("private key") || lower.includes("address:")) {
      found = true;

      console.log("\n🎯 POSSIBLE RESULT DETECTED\n");

      const timestamp = new Date().toISOString();
      const saveBlock = 
`================================
TIME: ${timestamp}

${text}

================================

`;

      // Save to results.txt
      fs.appendFileSync(RESULT_FILE, saveBlock);
    }
  });

  child.stderr.on("data", (data) => {
    console.error("\nError:", data.toString());
  });

  child.on("close", (code) => {
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`\nProcess finished (exit ${code}) after ${duration}s`);

    if (!found) {
      console.log("\nNo matching address found in this run.");
    } else {
      console.log(`\n✅ Results saved to ${RESULT_FILE}`);
    }

    rl.close();
  });

});