// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HDNodeWallet, Interface, JsonRpcProvider } from 'ethers';
import { compile } from './compile.mjs';
import { publicRPC } from './research-deploy.mjs';

const base = path.resolve(process.argv[2] ?? '');
if (!base.includes(`${path.sep}.state${path.sep}`)) throw new Error('explicit ignored research state directory required');
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'deployment.json'), 'utf8'));
if (manifest.chain_id !== 297012 || Number(await publicRPC(manifest.rpc_url, 'eth_chainId')) !== 297012) throw new Error('EVM probes run only on the accelerated local chain');
const accounts = JSON.parse(fs.readFileSync(path.join(base, 'public-accounts.json'), 'utf8'));
const key = JSON.parse(fs.readFileSync(path.join(base, 'node0/private/faucet.json'), 'utf8'));
const provider = new JsonRpcProvider(manifest.rpc_url, 297012, { staticNetwork: true });
const signer = HDNodeWallet.fromPhrase(key.mnemonic, '', "m/44'/118'/0'/0/0").connect(provider);
if (signer.address.toLowerCase() !== accounts.faucet.evm_address.toLowerCase()) throw new Error('public research identity mismatch');
const artifacts = compile({ testFixtures: true });
const evidence = { chain_id: 297012, genesis_hash: manifest.genesis_hash, cases: [], notice: 'Live local-chain EVM probes, not Ethereum-equivalence or consensus-security proof.' };
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function nativeSupply(height) {
  const args = ['query','bank','total-supply-of','aheyuna','--node',manifest.cosmos_rpc_url,
    '--home',path.join(base,'node0'),'--output','json'];
  if (height !== undefined) args.push('--height', String(height));
  return BigInt(JSON.parse(execFileSync(path.join(projectRoot,'.state/bin/heyunad'),args,{encoding:'utf8',maxBuffer:1_000_000})).amount.amount);
}
const supplyBefore = nativeSupply();
async function tx(label, to, data, value = 0n, expected = 1) {
  const transaction = await signer.sendTransaction({ to, data, value, chainId: 297012, type: 0, gasPrice: 0n, gasLimit: 2_000_000n });
  let receipt;
  try { receipt = await transaction.wait(1, 60_000); } catch (error) { receipt = error.receipt; if (!receipt) throw error; }
  if (receipt.status !== expected) throw new Error(`${label}: unexpected execution status`);
  evidence.cases.push({ label, transaction_hash: receipt.hash, block: receipt.blockNumber, status: receipt.status, gas_used: receipt.gasUsed.toString() });
  return receipt;
}
const abi = new Interface(artifacts.CompatibilityProbe.abi);
const deployed = await tx('Solidity deployment', undefined, `0x${artifacts.CompatibilityProbe.evm.bytecode.object}`);
const address = deployed.contractAddress;
await tx('storage and event', address, abi.encodeFunctionData('set', [42]));
const result = await publicRPC(manifest.rpc_url, 'eth_call', [{ to: address, data: abi.encodeFunctionData('value') }, 'latest']);
if (abi.decodeFunctionResult('value', result)[0] !== 42n) throw new Error('storage/read call mismatch');
await tx('revert is charged but does not mutate storage', address, abi.encodeFunctionData('fail'), 0n, 0);
await tx('storage fill', address, abi.encodeFunctionData('fill'));
await tx('storage clear with refund accounting', address, abi.encodeFunctionData('clear'));
const cleared = await publicRPC(manifest.rpc_url, 'eth_call', [{ to: address, data: abi.encodeFunctionData('slots', [0]) }, 'latest']);
if (abi.decodeFunctionResult('slots', cleared)[0] !== 0n) throw new Error('storage refund probe did not clear state');
await tx('native transfer', accounts.validators[0].evm_address, '0x', 10n ** 18n);
const destroyed = await tx('one-base-unit constructor SELFDESTRUCT', undefined, `0x${artifacts.ConstructorBurnProbe.evm.bytecode.object}`, 1n);
const supplyAfter = nativeSupply(destroyed.blockNumber);
if (supplyBefore - supplyAfter !== 1n) throw new Error('P1: native supply did not reconcile the one-base-unit execution burn');
const destroyedBalance = await publicRPC(manifest.rpc_url, 'eth_getBalance', [destroyed.contractAddress, 'latest']);
const destroyedCode = await publicRPC(manifest.rpc_url, 'eth_getCode', [destroyed.contractAddress, 'latest']);
if (BigInt(destroyedBalance) !== 0n || destroyedCode !== '0x') throw new Error('SELFDESTRUCT account state does not match the supply decrease');
evidence.native_supply = { before: supplyBefore.toString(), after: supplyAfter.toString(), protocol_burn: '1',
  exact_decrease: true, deleted_account_balance: '0', deleted_account_code: '0x', height: destroyed.blockNumber };
const precompile = new Interface(['function getEpoch(uint256) view returns(bytes32,uint256,uint256,bool)']);
const epoch = await publicRPC(manifest.rpc_url, 'eth_call', [{ to: manifest.contribution_precompile_address, data: precompile.encodeFunctionData('getEpoch', [999999]) }, 'latest']);
if (precompile.decodeFunctionResult('getEpoch', epoch)[3] !== false) throw new Error('unfinalized epoch unexpectedly confirmed');
evidence.cases.push({ label: 'read-only native precompile eth_call', passed: true });
try {
  await publicRPC(manifest.rpc_url, 'eth_call', [{ to: manifest.contribution_precompile_address, data: '0xffffffff' }, 'latest']);
  throw new Error('unknown precompile selector unexpectedly accepted');
} catch (error) {
  if (!String(error).includes('RPC eth_call failed')) throw error;
  evidence.cases.push({ label: 'unknown precompile selector rejected', passed: true });
}
fs.writeFileSync(path.join(base, 'evm-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify(evidence, null, 2));
provider.destroy();
