// SPDX-License-Identifier: Apache-2.0
// Produces unsigned Sepolia deployment data. Intentionally has no signer, wallet, RPC, or send method.
import fs from 'node:fs';
import { Interface, getAddress } from 'ethers';
import { compile } from './compile.mjs';

const configPath = process.argv[2];
if (!configPath) {
  console.error('Usage: pnpm deployment-plan ./deployments/sepolia.local.json');
  console.error('Config: {chainId:11155111,rewardValidators:[3 addresses],fundValidators:[3 addresses],genesis:future Unix seconds}');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (config.chainId !== 11155111) throw new Error('Only Ethereum Sepolia is supported. Mainnet deployment is blocked.');
for (const key of ['rewardValidators', 'fundValidators']) {
  if (!Array.isArray(config[key]) || config[key].length !== 3) throw new Error(`${key}: exactly three independent operator addresses required`);
  config[key] = config[key].map(getAddress);
  if (config[key].some((entry) => /^0x0{40}$/.test(entry)) || new Set(config[key]).size !== 3) throw new Error(`${key}: zero or duplicate address`);
}
if (!Number.isSafeInteger(config.genesis) || config.genesis < Math.floor(Date.now() / 1000) + 3600) throw new Error('Choose genesis at least one hour in the future');
const artifact = compile().HeyunaTestnet;
const data = `0x${artifact.evm.bytecode.object}${new Interface(artifact.abi).encodeDeploy([config.rewardValidators, config.fundValidators, config.genesis]).slice(2)}`;
console.log(JSON.stringify({ chainId: 11155111, value: '0', data, config, notice: 'UNSIGNED. No transaction sent. Independent operators, source review and explicit signer setup remain required.' }, null, 2));
