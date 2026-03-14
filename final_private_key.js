// final_private_key.js
// Combine profanity3 result with fixed seed key

const readline = require("readline");
const { ethers } = require("ethers");

// ─────────────────────────────
// CONSTANT SEED KEYS
// ─────────────────────────────

const SEED_PRIVATE_KEY =
"0xba2be0784fc464731a1d33291b0ad9f98e26221d0d5d6a41604af575f5a3de3c";

const SEED_PUBLIC_KEY =
"c5f3f912e73956078d8c7eb4a626827158681c1be38d23c3bc4150395457d89a16a0607a4eb63ad8428297b87b4d995bad674b442c093ddc2d5d7b22e701b544";

// secp256k1 curve order
const N = BigInt(
"0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);

// ─────────────────────────────

const rl = readline.createInterface({
input: process.stdin,
output: process.stdout
});

function combineKeys(seedPriv, foundPriv){

const a = BigInt(seedPriv);
const b = BigInt(foundPriv);

const combined = (a + b) % N;

return "0x" + combined.toString(16).padStart(64,"0");
}

console.log("\nEthereum Vanity Key Combiner\n");

rl.question("Paste PRIVATE KEY from profanity3 output: ", (found) => {

try{

const finalKey = combineKeys(
SEED_PRIVATE_KEY,
found.trim()
);

const wallet = new ethers.Wallet(finalKey);

console.log("\n✅ Final Private Key:");
console.log(finalKey);

console.log("\n🎯 Address:");
console.log(wallet.address);

console.log("\nImport this key into MetaMask.");

}catch(err){

console.log("\n❌ Error:", err.message);

}

rl.close();

});