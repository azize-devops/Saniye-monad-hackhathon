// Deploy SaniyePay to Monad testnet WITHOUT Foundry.
// Usage:  npm install && npm run deploy
//   - No PRIVATE_KEY needed: on first run a fresh deployer wallet is created and saved to
//     .deployer-key (git-ignored). Send it some testnet MON, then run the command again.
//   - Or set PRIVATE_KEY to use your own key.
// It compiles src/SaniyePay.sol, deploys it, registers the demo service
// and writes the address into frontend/config.js.
import solc from "solc";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseEther, formatEther, parseEventLogs } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const KEY_FILE = path.join(root, ".deployer-key");

// Accept keys with or without 0x, strip spaces/quotes (MetaMask exports without 0x).
let PK = (process.env.PRIVATE_KEY || "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");
if (PK && !PK.startsWith("0x")) PK = "0x" + PK;
if (PK && !/^0x[0-9a-fA-F]{64}$/.test(PK)) {
  console.warn(
    `PRIVATE_KEY gecersiz (${PK.length} karakter; 42 karakter ise bu bir cuzdan ADRESI, anahtar degil).\n` +
      `Onun yerine otomatik deploy cuzdani kullaniliyor.\n`
  );
  PK = "";
}
if (!PK) {
  if (fs.existsSync(KEY_FILE)) PK = fs.readFileSync(KEY_FILE, "utf8").trim();
  else {
    PK = generatePrivateKey();
    fs.writeFileSync(KEY_FILE, PK);
  }
}

const chain = {
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

// 1) compile
const source = fs.readFileSync(path.join(root, "src/SaniyePay.sol"), "utf8");
const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "SaniyePay.sol": { content: source } },
      settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
    })
  )
);
const errors = (output.errors || []).filter((e) => e.severity === "error");
if (errors.length) {
  errors.forEach((e) => console.error(e.formattedMessage));
  process.exit(1);
}
const { abi, evm } = output.contracts["SaniyePay.sol"].SaniyePay;
const bytecode = "0x" + evm.bytecode.object;

// 2) deploy
const account = privateKeyToAccount(PK);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });
console.log("Deployer:", account.address, "balance:", formatEther(await pub.getBalance({ address: account.address })), "MON");
if ((await pub.getBalance({ address: account.address })) < parseEther("0.05")) {
  console.log(
    `\n>>> Deploy cuzdaninda yeterli MON yok.\n` +
      `>>> Su adrese biraz test MON gonderin (0.5 MON yeter):\n\n      ${account.address}\n\n` +
      `>>> MetaMask'tan bu adrese gonderebilir ya da blitz.devnads.com / faucet.monad.xyz kullanabilirsiniz.\n` +
      `>>> Sonra ayni komutu tekrar calistirin: npm.cmd run deploy\n`
  );
  process.exit(0);
}

const deployHash = await wallet.deployContract({ abi, bytecode });
const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
const address = deployRcpt.contractAddress;
console.log("SaniyePay deployed:", address);

// 3) register demo service (0.18 MON / hour)
const name = process.env.SERVICE_NAME || "Kadıköy Otopark";
const perHour = parseEther(process.env.PRICE_PER_HOUR || "0.18");
const regHash = await wallet.writeContract({ address, abi, functionName: "registerService", args: [name, perHour / 3600n] });
const regRcpt = await pub.waitForTransactionReceipt({ hash: regHash });
const [ev] = parseEventLogs({ abi, logs: regRcpt.logs, eventName: "ServiceRegistered" });
const serviceId = Number(ev.args.serviceId);
console.log(`Service #${serviceId} registered: ${name}`);

// 4) write frontend config
const cfgPath = path.join(root, "frontend/config.js");
let cfg = fs.readFileSync(cfgPath, "utf8");
cfg = cfg.replace(/contractAddress:\s*"[^"]*"/, `contractAddress: "${address}"`);
cfg = cfg.replace(/serviceId:\s*\d+/, `serviceId: ${serviceId}`);
cfg = cfg.replace(/deployBlock:\s*\d+/, `deployBlock: ${deployRcpt.blockNumber}`);
fs.writeFileSync(cfgPath, cfg);
fs.writeFileSync(path.join(root, "frontend/abi.js"), `// Auto-generated from src/SaniyePay.sol\nexport const ABI = ${JSON.stringify(abi, null, 2)};\n`);
console.log("frontend/config.js updated.");
console.log(`Explorer: https://testnet.monadvision.com/address/${address}`);
