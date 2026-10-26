// SPDX-License-Identifier: Apache-2.0
// Only loopback research identities are supported. Never prints signing material.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HDNodeWallet, Interface, JsonRpcProvider, keccak256 } from 'ethers';
import { canonicalJSON } from './native-protocol.mjs';

const sha256 = value => `0x${createHash('sha256').update(canonicalJSON(value)).digest('hex')}`;
export async function publicRPC(url, method, params = []) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('only loopback research RPC is allowed');
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const raw = await response.text();
  if (!response.ok || raw.length > 4_000_000) throw new Error('invalid or oversized RPC response');
  const body = JSON.parse(raw);
  if (body.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(body.error).slice(0, 300)}`);
  return body.result;
}

export async function researchDeploy(directory) {
  const base = path.resolve(directory);
  if (!base.includes(`${path.sep}.state${path.sep}`)) throw new Error('research keys must remain inside ignored .state');
  const operations = JSON.parse(fs.readFileSync(path.join(base, 'network-manifest.json'), 'utf8'));
  const contracts = JSON.parse(fs.readFileSync(path.join(base, 'genesis-contracts.json'), 'utf8'));
  const accounts = JSON.parse(fs.readFileSync(path.join(base, 'public-accounts.json'), 'utf8'));
  const chainId = Number(operations.evm_chain_id);
  if (![297011, 297012].includes(chainId) || Number(await publicRPC(operations.rpc_url, 'eth_chainId')) !== chainId) throw new Error('research chain mismatch');
  const privatePath = path.join(base, 'node0/private/faucet.json');
  if (process.platform !== 'win32' && (fs.statSync(privatePath).mode & 0o077) !== 0) throw new Error('research key file must be private');
  const keyRecord = JSON.parse(fs.readFileSync(privatePath, 'utf8'));
  const provider = new JsonRpcProvider(operations.rpc_url, chainId, { staticNetwork: true });
  // The pinned SDK CLI currently defaults to coin type 118 even for its
  // eth_secp256k1 key algorithm. Check the derived public identity below.
  const wallet = HDNodeWallet.fromPhrase(keyRecord.mnemonic, '', "m/44'/118'/0'/0/0").connect(provider);
  if (wallet.address.toLowerCase() !== accounts.faucet.evm_address.toLowerCase()) throw new Error('local faucet derivation does not match public genesis identity');
  const factoryABI = new Interface(['function deploy(bytes32 salt,bytes initCode) returns(address)']);
  const factoryCode = await publicRPC(operations.rpc_url, 'eth_getCode', [contracts.factory.address, 'latest']);
  if (keccak256(factoryCode) !== contracts.factory.expected_runtime_code_hash) throw new Error('genesis factory code hash mismatch');
  const transactions = [];
  for (const name of ['public_fund', 'reward_vault']) {
    const contract = contracts[name];
    let code = await publicRPC(operations.rpc_url, 'eth_getCode', [contract.address, 'latest']);
    if (code === '0x') {
      const transaction = await wallet.sendTransaction({ to: contracts.factory.address,
        data: factoryABI.encodeFunctionData('deploy', [contract.salt, contract.creation_bytecode]),
        chainId, type: 0, gasPrice: 0n, gasLimit: 12_000_000n });
      const receipt = await transaction.wait(1, 60_000);
      if (!receipt || receipt.status !== 1) throw new Error(`${name} deployment was not confirmed`);
      transactions.push({ contract: name, tx_hash: receipt.hash, block_number: receipt.blockNumber, gas_used: receipt.gasUsed.toString() });
      code = await publicRPC(operations.rpc_url, 'eth_getCode', [contract.address, 'latest']);
    }
    if (keccak256(code) !== contract.expected_runtime_code_hash) throw new Error(`${name} runtime differs from deterministic genesis build`);
  }
  const cosmos = new URL('/genesis', operations.cosmos_rpc_url);
  const response = await fetch(cosmos, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const raw = await response.text();
  if (!response.ok || raw.length > 4_000_000) throw new Error('invalid genesis response');
  const genesis = JSON.parse(raw).result.genesis;
  if (genesis.chain_id !== operations.chain_id) throw new Error('Cosmos chain mismatch');
  const genesisHash = sha256(genesis);
  if (genesisHash !== operations.genesis_hash) throw new Error('live canonical genesis differs from initialized genesis');
  const anchor = await publicRPC(operations.rpc_url, 'eth_getBlockByNumber', ['0x1', false]);
  if (!anchor?.hash) throw new Error('EVM block one anchor is unavailable');
  const manifest = { version: 2, profile: chainId === 297012 ? 'accelerated-local' : 'research', chain_id: chainId,
    cosmos_chain_id: operations.chain_id, network_name: chainId === 297012 ? 'Heyuna Accelerated Local (3s challenge)' : 'Heyuna Researchnet',
    network_domain: contracts.network_domain, genesis_hash: genesisHash, genesis_hash_kind: 'sha256-canonical-genesis-json',
    evm_anchor: { block_number: 1, block_hash: anchor.hash }, rpc_url: operations.rpc_url, cosmos_rpc_url: operations.cosmos_rpc_url,
    asset_kind: 'native', symbol: 'tHEYUNA', base_denom: 'aheyuna', decimals: 18,
    total_supply: '20000000000000000000000000', reward_vault_address: contracts.reward_vault.address,
    public_fund_address: contracts.public_fund.address, factory_address: contracts.factory.address,
    contribution_precompile_address: contracts.contribution_precompile, genesis: contracts.start_time,
    challenge_seconds: chainId === 297012 ? 3 : 259200, confirmations: 1,
    code_hashes: { reward_vault: contracts.reward_vault.expected_runtime_code_hash,
      public_fund: contracts.public_fund.expected_runtime_code_hash, factory: contracts.factory.expected_runtime_code_hash } };
  fs.writeFileSync(path.join(base, 'deployment.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  const evidence = { version: 2, profile: manifest.profile, chain_id: chainId, genesis_hash: genesisHash, evm_anchor: manifest.evm_anchor,
    transactions, runtime_hashes_verified: true, native_genesis_supply: manifest.total_supply,
    reward_vault_balance: BigInt(await publicRPC(operations.rpc_url, 'eth_getBalance', [manifest.reward_vault_address, 'latest'])).toString(),
    public_fund_balance: BigInt(await publicRPC(operations.rpc_url, 'eth_getBalance', [manifest.public_fund_address, 'latest'])).toString(),
    zero_fee_bootstrap: true, independent_operators_verified: false, mainnet: false };
  fs.writeFileSync(path.join(base, 'deployment-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
  provider.destroy();
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: node scripts/research-deploy.mjs .state/chain-accelerated');
  console.log(JSON.stringify(await researchDeploy(process.argv[2]), null, 2));
}
