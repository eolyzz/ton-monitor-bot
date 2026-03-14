const { Wallet, SigningKey } = require('ethers');

const wallet = Wallet.createRandom();
const signingKey = new SigningKey(wallet.privateKey);

// full uncompressed key
const full = signingKey.publicKey;

// remove 0x04 prefix
const seed = full.slice(4);

console.log("\n=== COPY THIS ===");
console.log(seed);
console.log("Length:", seed.length);
console.log("=== END ===\n");

console.log("Private key:", wallet.privateKey);
console.log("Address:", wallet.address);