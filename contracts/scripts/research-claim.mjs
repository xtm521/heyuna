// SPDX-License-Identifier: Apache-2.0
// Explicit accelerated-local research claim, never a mainnet wallet operation.
import fs from 'node:fs';
import path from 'node:path';
import { HDNodeWallet, Interface, JsonRpcProvider } from 'ethers';
import { nativeBundle } from './native-protocol.mjs';
import { publicRPC } from './research-deploy.mjs';

const base = path.resolve(process.argv[2] ?? '');
if (!base.includes(`${path.sep}.state${path.sep}`)) throw new Error('explicit ignored research state directory required');
const deployment = JSON.parse(fs.readFileSync(path.join(base, 'deployment.json'), 'utf8'));
if (deployment.chain_id !== 297012 || Number(await publicRPC(deployment.rpc_url, 'eth_chainId')) !== 297012) throw new Error('only accelerated local chain is permitted');
const smoke = JSON.parse(fs.readFileSync(path.join(base, 'contribution-smoke.json'), 'utf8'));
const epoch = smoke.epoch;
if (epoch.status !== 'finalized' || epoch.entries.length < 1 || epoch.entries.length > 128) throw new Error('expected finalized bounded local smoke allocations');
const bundle = nativeBundle({ chainId: deployment.chain_id, genesisHash: deployment.genesis_hash,
  rewardVault: deployment.reward_vault_address, epoch: epoch.id,
  allocations: epoch.entries.map(a => ({ ...a, contribution_id: a.receipt_id })) });
if (bundle.root !== epoch.root) throw new Error('SDK/OZ Merkle root mismatch');
const key = JSON.parse(fs.readFileSync(path.join(base, 'node0/private/faucet.json'), 'utf8'));
const provider = new JsonRpcProvider(deployment.rpc_url, 297012, { staticNetwork: true });
const signer = HDNodeWallet.fromPhrase(key.mnemonic, '', "m/44'/118'/0'/0/0").connect(provider);
const accounts = JSON.parse(fs.readFileSync(path.join(base, 'public-accounts.json'), 'utf8'));
if (signer.address.toLowerCase() !== accounts.faucet.evm_address.toLowerCase()) throw new Error('dedicated local faucet relayer required');
const abi = new Interface(JSON.parse(fs.readFileSync(new URL('../abi/NativeRewardVault.json', import.meta.url), 'utf8')));
const oracle = new Interface(['function getEpoch(uint256) view returns(bytes32,uint256,uint256,bool)']);
const raw = await publicRPC(deployment.rpc_url, 'eth_call', [{ to: deployment.contribution_precompile_address,
  data: oracle.encodeFunctionData('getEpoch', [bundle.manifest.epoch]) }, 'latest']);
const onchain = oracle.decodeFunctionResult('getEpoch', raw);
if (!onchain[3] || onchain[0] !== bundle.root || onchain[1].toString() !== bundle.training_budget || onchain[2].toString() !== bundle.verification_budget) throw new Error('finalized oracle does not match bundle');
const evidence = { chain_id: 297012, genesis_hash: deployment.genesis_hash, challenge_seconds: 3,
  task_hash: smoke.offchain_task_hash, root: bundle.root, claims: [], real_local_chain: true,
  independent_operators: false, mainnet: false };
fs.writeFileSync(path.join(base, 'reward-bundle.v2.json'), JSON.stringify(bundle,null,2)+'\n');
for (const claim of bundle.claims) {
  const args = [claim.epoch, claim.index, claim.recipient, claim.category, claim.amount, claim.contribution_id, claim.proof];
  const before = BigInt(await publicRPC(deployment.rpc_url, 'eth_getBalance', [claim.recipient, 'latest']));
  const vaultBefore = BigInt(await publicRPC(deployment.rpc_url, 'eth_getBalance', [deployment.reward_vault_address, 'latest']));
  const transaction = await signer.sendTransaction({ to: deployment.reward_vault_address, data: abi.encodeFunctionData('claim', args),
    chainId: 297012, type: 0, gasPrice: 0n, gasLimit: 1_000_000n });
  const receipt = await transaction.wait(1, 60_000);
  if (!receipt || receipt.status !== 1) throw new Error('native research claim not confirmed');
  const events = receipt.logs.filter(log => log.address.toLowerCase() === deployment.reward_vault_address.toLowerCase())
    .map(log => { try { return abi.parseLog(log); } catch { return null; } }).filter(log => log?.name === 'RewardClaimed');
  if (events.length !== 1 || events[0].args.recipient.toLowerCase() !== claim.recipient || events[0].args.amount.toString() !== claim.amount || events[0].args.contributionId !== claim.contribution_id) throw new Error('claim receipt event mismatch');
  const after = BigInt(await publicRPC(deployment.rpc_url, 'eth_getBalance', [claim.recipient, 'latest']));
  const vaultAfter = BigInt(await publicRPC(deployment.rpc_url, 'eth_getBalance', [deployment.reward_vault_address, 'latest']));
  if (after-before !== BigInt(claim.amount) || vaultBefore-vaultAfter !== BigInt(claim.amount)) throw new Error('native reward balance reconciliation failed');
  try {
    await publicRPC(deployment.rpc_url, 'eth_call', [{ to: deployment.reward_vault_address, from: signer.address, data: abi.encodeFunctionData('claim', args) }, 'latest']);
    throw new Error('duplicate claim unexpectedly accepted');
  } catch(error) { if (!String(error).includes('RPC eth_call failed')) throw error; }
  evidence.claims.push({ contribution_id: claim.contribution_id, epoch: claim.epoch, index: claim.index,
    category: claim.category, recipient: claim.recipient, amount: claim.amount,
    transaction_hash: receipt.hash, block_number: receipt.blockNumber, status: receipt.status,
    gas_used: receipt.gasUsed.toString(), gas_price: '0', recipient_balance_before: before.toString(), recipient_balance_after: after.toString(),
    reward_vault_before: vaultBefore.toString(), reward_vault_after: vaultAfter.toString(),
    event_verified: true, balances_reconciled: true, duplicate_claim_rejected: true });
  fs.writeFileSync(path.join(base, 'claim-evidence.json'), JSON.stringify(evidence,null,2)+'\n');
}
console.log(JSON.stringify(evidence,null,2)); provider.destroy();
