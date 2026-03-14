// gpu_hunter.js
// Ethereum vanity matcher using profanity3

const { spawn } = require("child_process");
const readline = require("readline");
const { ethers } = require("ethers");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// ─────────────────────────────
// CONFIGURATION
// ─────────────────────────────

const PROFANITY_EXE = ".\\profanity3.exe";

// 128 hex chars from UNCOMPRESSED public key (without 0x04)
const SEED_PUBKEY =
"3dc69591776e1e7540ee2a44b6173e29f02a55407d01e5acc210bbf0d5d64f7b1c8da31986663e0d8e3a43a177ae912eeece36be1f7e8ae3b97df88a6a0c8d72";

// Skip problematic GPUs
const SKIP_DEVICES = ["-s","1","-s","2","-s","3"];

// Kernel stability flags
const EXTRA_FLAGS = [
  "-n",          // disable kernel cache
  "-w","32",     // smaller work size
  "-W","4096"    // max work limit
];

const PREFIX_LENGTH = 1;
const SUFFIX_LENGTH = 1;
const ADDRESS_LENGTH = 40;

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

  const pattern =
    prefix +
    "X".repeat(wildcardLength) +
    suffix;

  console.log("\nTarget pattern");
  console.log("Prefix :", prefix);
  console.log("Suffix :", suffix);
  console.log("Wildcard length:", wildcardLength);
  console.log("Pattern:", pattern);

  if (
    !SEED_PUBKEY ||
    SEED_PUBKEY.length !== 128 ||
    !/^[0-9a-fA-F]{128}$/.test(SEED_PUBKEY)
  ) {
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

  const child = spawn(PROFANITY_EXE, args);

  let found = false;

  child.stdout.on("data", (data) => {

    const text = data.toString();
    process.stdout.write(text);

    const lower = text.toLowerCase();

    if (
      lower.includes("private key") ||
      lower.includes("address:")
    ) {
      found = true;
      console.log("\n🎯 POSSIBLE RESULT DETECTED\n");
    }

  });

  child.stderr.on("data", (data) => {
    console.error("\nError:", data.toString());
  });

  child.on("close", (code) => {

    const duration =
      ((Date.now() - start) / 1000).toFixed(2);

    console.log(
      `\nProcess finished (exit ${code}) after ${duration}s`
    );

    if (!found) {
      console.log("\nNo matching address found in this run.");
    } else {
      console.log("\nCheck output above for private key result.");
    }

    rl.close();
  });

});