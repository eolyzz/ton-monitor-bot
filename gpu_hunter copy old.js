// gpu_hunter.js
// Hunts for Ethereum vanity addresses with similar prefix + suffix to a target address
// Uses profanity3.exe (RTX GPU accelerated)
// Requires: Node.js + npm install ethers

const { exec } = require('child_process');
const readline = require('readline');
const { ethers } = require('ethers');

const rl = readline.createInterface({
input: process.stdin,
output: process.stdout
});

// ────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────

const PROFANITY_EXE = 'profanity3.exe'; // change if your file is named differently (profanity.exe, profanity.x64, etc)

const SEED_PUBKEY = '3dc69591776e1e7540ee2a44b6173e29f02a55407d01e5acc210bbf0d5d64f7b1c8da31986663e0d8e3a43a177ae912eeece36be1f7e8ae3b97df88a6a0c8d72';
// ↑↑↑ MUST REPLACE THIS with your 128 hex char uncompressed pubkey (no 0x, no leading 04)
// Example: 'a1b2c3d4e5f67890... (exactly 128 characters)'
console.log('Debug - SEED_PUBKEY length:', SEED_PUBKEY.length);
console.log('Debug - SEED_PUBKEY starts with:', SEED_PUBKEY.substring(0, 10));


const EXTRA_FLAGS = ''; // optional: ' -c' (case sensitive), ' -t 6' (more CPU threads), etc.

// How many characters from start and end to match
const PREFIX_LENGTH = 5; // first 7 characters after 0x
const SUFFIX_LENGTH = 4; // last 6 characters

// ────────────────────────────────────────────────

console.log('GPU Hunter - Ethereum vanity address matcher');
console.log('Using profanity3.exe + RTX GPU acceleration\n');

rl.question('Paste target Ethereum address (0x...): ', (input) => {
const target = input.trim();

if (!ethers.isAddress(target)) {
console.log('\n❌ Not a valid Ethereum address.');
rl.close();
return;
}

const prefix = target.substring(2, 2 + PREFIX_LENGTH).toLowerCase();
const suffix = target.slice(-SUFFIX_LENGTH).toLowerCase();

console.log('\nTarget pattern:');
console.log(`Prefix: 0x${prefix}`);
console.log(`Suffix: ...${suffix}`);
console.log(`Full target: ${target}\n`);

if (!SEED_PUBKEY || SEED_PUBKEY.length !== 128 || !/^[0-9a-fA-F]{128}$/.test(SEED_PUBKEY)) {
console.log('❌ ERROR: SEED_PUBKEY is missing or invalid.');
console.log('You must paste a 128-character hex string (no 0x, no leading 04).');
rl.close();
return;
}

const cmd = `"${PROFANITY_EXE}" -z ${SEED_PUBKEY} -b ${prefix} -s ${suffix}${EXTRA_FLAGS}`;

console.log('Running command:');
console.log(cmd);
console.log('\nSearching... (can take seconds to hours depending on pattern length)\n');

const startTime = Date.now();

const child = exec(cmd);

let found = false;

child.stdout.on('data', (data) => {
process.stdout.write(data);

const text = data.toString().toLowerCase();
if (text.includes('found') || text.includes('match') || text.includes('address:')) {
found = true;
console.log('\n╔════════════════════════════════════════════╗');
console.log('║ MATCH LIKELY FOUND ║');
console.log('╚════════════════════════════════════════════╝');
}
});

child.stderr.on('data', (data) => {
console.error(`\nError output: ${data}`);
});

child.on('close', (code) => {
const duration = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nProcess finished (exit code ${code}) after ${duration} seconds.`);

if (!found) {
console.log('No match found in this run.');
} else {
console.log('\nCheck the output above for the address + tweak value.');
console.log('You will need to add the tweak to your seed private key manually.');
}

rl.close();
});
});