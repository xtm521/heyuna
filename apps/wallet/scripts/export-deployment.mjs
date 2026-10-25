// SPDX-License-Identifier: Apache-2.0
// Read-only public configuration export. No wallet, private key, signature or transaction sending.
import { Contract, JsonRpcProvider, getAddress, keccak256 } from 'ethers';

let provider;
try {
  const factoryAddress = getAddress(process.argv[2] ?? '');
  const rpc = process.env.HEYUNA_SEPOLIA_RPC_URL;
  if (!rpc) throw new Error('Missing RPC');
  const url = new URL(rpc);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Unsafe RPC transport');
  provider = new JsonRpcProvider(rpc);
  const network = await provider.getNetwork();
  if (network.chainId !== 11155111n) throw new Error('Only Ethereum Sepolia is accepted.');
  const factory = new Contract(factoryAddress, ['function token() view returns(address)', 'function rewards() view returns(address)', 'function publicFund() view returns(address)'], provider);
  const [tokenAddress, rewardsAddress, fundAddress] = await Promise.all([factory.token(), factory.rewards(), factory.publicFund()]);
  const token = new Contract(tokenAddress, ['function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)', 'function symbol() view returns(string)'], provider);
  const reward = new Contract(rewardsAddress, ['function token() view returns(address)', 'function genesis() view returns(uint256)'], provider);
  const fund = new Contract(fundAddress, ['function token() view returns(address)'], provider);
  const [decimals, supply, symbol, genesis, rewardToken, fundToken] = await Promise.all([token.decimals(), token.totalSupply(), token.symbol(), reward.genesis(), reward.token(), fund.token()]);
  if (decimals !== 18n || supply !== 20_000_000n * 10n ** 18n || symbol !== 'tHEYUNA' || rewardToken !== tokenAddress || fundToken !== tokenAddress) throw new Error('Deployed contract parameters do not match the protocol.');
  if (genesis > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid genesis timestamp.');
  const code_hashes = {};
  for (const [name, target] of [['factory', factoryAddress], ['token', tokenAddress], ['reward_vault', rewardsAddress], ['public_fund', fundAddress]]) {
    const code = await provider.getCode(target);
    if (code === '0x') throw new Error(`Missing deployed code: ${name}`);
    code_hashes[name] = keccak256(code);
  }
  console.log(JSON.stringify({ version: 1, chain_id: 11155111, factory_address: factoryAddress, token_address: tokenAddress,
    reward_vault_address: rewardsAddress, public_fund_address: fundAddress, genesis: Number(genesis), decimals: 18,
    total_supply: supply.toString(), confirmations: 3, code_hashes }, null, 2));
} catch {
  // Do not expose RPC URLs (some providers include API credentials in error messages).
  console.error('Deployment export failed. Check Sepolia network, factory address, RPC availability and protocol parameters. No transaction was sent.');
  process.exitCode = 1;
} finally { provider?.destroy(); }
