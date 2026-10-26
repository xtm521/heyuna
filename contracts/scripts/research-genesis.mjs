// SPDX-License-Identifier: Apache-2.0
// Public deterministic deployment material; this program never reads signing keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBlock } from '@ethereumjs/block';
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { createAccount, createAddressFromString, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { createVM } from '@ethereumjs/vm';
import { Interface, getAddress, getCreate2Address, keccak256, toUtf8Bytes } from 'ethers';
import { compile } from './compile.mjs';
import { NATIVE_CHAIN_IDS, ORACLE_ADDRESS, FACTORY_ADDRESS } from './native-protocol.mjs';

export async function genesisContracts(accounts, startTime) {
  const chainId = Number(accounts.evm_chain_id);
  if (!NATIVE_CHAIN_IDS.includes(chainId) || accounts.chain_id !== `heyuna_${chainId}-1`) throw new Error('unsupported chain identity');
  if (!Number.isSafeInteger(startTime) || startTime <= 0) throw new Error('start-time must be a Unix timestamp');
  const address = entry => getAddress(entry.evm_address);
  const managers = accounts.fund_managers.map(address);
  const verifiers = accounts.verifiers.map(address);
  const faucet = address(accounts.faucet);
  if (managers.length !== 5 || new Set(managers).size !== 5 || verifiers.length !== 3 || new Set(verifiers).size !== 3) throw new Error('need five fund managers and three verifiers');
  const roles = [...managers, ...verifiers, faucet, ...accounts.validators.map(address)];
  if (new Set(roles).size !== roles.length || roles.some(a => BigInt(a) === 0n)) throw new Error('research role keys must be distinct and nonzero');
  const artifacts = compile({ write: true });
  const factoryArtifact = artifacts.ResearchCreate2Factory;
  const factoryABI = new Interface(factoryArtifact.abi);
  const factoryRuntime = `0x${factoryArtifact.evm.deployedBytecode.object}`;
  const result = { version: 1, chain_id: accounts.chain_id, evm_chain_id: chainId, start_time: startTime,
    network_domain: keccak256(toUtf8Bytes(`heyuna-research-v2:${accounts.chain_id}:${startTime}:${verifiers.join(',')}`)),
    factory: { address: FACTORY_ADDRESS, runtime_bytecode: factoryRuntime, expected_runtime_code_hash: keccak256(factoryRuntime) },
    verifiers, fund_managers: managers, faucet, contribution_precompile: ORACLE_ADDRESS,
    notice: 'Loopback research genesis. Accelerated chain 297012 has a 3-second challenge; 297011 retains 72 hours. Not mainnet.' };
  const common = createCustomCommon({ chainId }, Mainnet, { hardfork: Hardfork.Cancun });
  const vm = await createVM({ common });
  const factory = createAddressFromString(FACTORY_ADDRESS);
  await vm.stateManager.putAccount(factory, createAccount({ nonce: 1n }));
  await vm.stateManager.putCode(factory, hexToBytes(factoryRuntime));
  const block = createBlock({ header: { number: 1n, timestamp: BigInt(startTime), gasLimit: 30_000_000n, baseFeePerGas: 0n } }, { common });
  for (const [key, name, args, balance] of [
    ['reward_vault', 'NativeRewardVault', [], 14_000_000n * 10n ** 18n],
    ['public_fund', 'NativePublicFund', [managers, faucet], 2_000_000n * 10n ** 18n],
  ]) {
    const abi = new Interface(artifacts[name].abi);
    const initCode = `0x${artifacts[name].evm.bytecode.object}${abi.encodeDeploy(args).slice(2)}`;
    const salt = keccak256(toUtf8Bytes(`heyuna-v2:${accounts.chain_id}:${key}`));
    const contractAddress = getCreate2Address(FACTORY_ADDRESS, salt, keccak256(initCode));
    const target = createAddressFromString(contractAddress);
    await vm.stateManager.putAccount(target, createAccount({ balance }));
    // Materialize immutable constructor values at the real CREATE2 address so
    // the hash checks the actual runtime, not unresolved solc placeholders.
    const execution = await vm.evm.runCall({ to: factory, caller: createAddressFromString(faucet),
      data: hexToBytes(factoryABI.encodeFunctionData('deploy', [salt, initCode])), gasLimit: 25_000_000n, block });
    if (execution.execResult.exceptionError) throw new Error(`${name}: deterministic constructor failed: ${bytesToHex(execution.execResult.returnValue)}`);
    const runtime = await vm.stateManager.getCode(target);
    if (!runtime.length) throw new Error(`${name}: no runtime after CREATE2 simulation`);
    result[key] = { address: contractAddress, salt, creation_bytecode: initCode, init_code_hash: keccak256(initCode),
      expected_runtime_code_hash: keccak256(runtime), genesis_balance: balance.toString(), constructor_args: args };
  }
  const faucetBalance = (await vm.stateManager.getAccount(createAddressFromString(faucet)))?.balance ?? 0n;
  if (faucetBalance !== 100_000n * 10n ** 18n) throw new Error('fixed faucet grant mismatch');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [accountsFile, outputFile, start] = process.argv.slice(2);
  if (!accountsFile || !outputFile || !start) throw new Error('usage: node scripts/research-genesis.mjs PUBLIC_ACCOUNTS OUTPUT UNIX_START_TIME');
  if (fs.existsSync(outputFile)) throw new Error('Refusing to overwrite an existing genesis contract manifest');
  const result = await genesisContracts(JSON.parse(fs.readFileSync(accountsFile, 'utf8')), Number(start));
  fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
  console.log(`Public CREATE2 genesis material written to ${outputFile}; no chain deployment or private-key read.`);
}
