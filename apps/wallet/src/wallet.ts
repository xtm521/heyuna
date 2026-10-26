import { WalletCheckError } from './presentation';
// SPDX-License-Identifier: Apache-2.0
import { BrowserProvider, Contract, Interface, getAddress, keccak256, toQuantity, type Eip1193Provider, type TransactionReceipt } from 'ethers';
import { CHAIN_ID, TOTAL_SUPPLY, verifyEpoch, verifyProof, type Bundle, type Claim, type Deployment, type Epoch } from './protocol';

export type InjectedProvider = Eip1193Provider & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};
export type Connection = { injected: InjectedProvider; provider: BrowserProvider; account: string };
export type Quote = {
  account: string; claim: Claim; data: string; gasLimit: bigint; gasEstimate: bigint;
  maxFeePerGas: bigint; maxPriorityFeePerGas: bigint | null; maximumFee: bigint; preparedAt: number;
  manifestHash: string; root: string;
};
const TOKEN_ABI = ['function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)', 'function symbol() view returns (string)'];
const FACTORY_ABI = ['function token() view returns (address)', 'function rewards() view returns (address)', 'function publicFund() view returns (address)'];
export const REWARDS_ABI = [
  'function token() view returns (address)', 'function genesis() view returns (uint256)', 'function paused() view returns (bool)',
  'function epochs(uint256) view returns (bytes32 root,bytes32 manifestHash,uint256 trainingAmount,uint256 validationAmount,uint256 trainingClaimed,uint256 validationClaimed,uint256 readyAt,uint256 nonce,uint8 state)',
  'function isClaimed(uint256,uint256) view returns (bool)',
  'function claim(uint256 epoch,uint256 index,address recipient,uint8 kind,uint256 amount,bytes32[] proof)',
  'event RewardClaimed(uint256 indexed epoch,uint256 indexed index,address indexed recipient,uint8 kind,uint256 amount)',
];
export const rewardsInterface = new Interface(REWARDS_ABI);

export async function assertSepolia(injected: InjectedProvider): Promise<void> {
  const chain = await injected.request({ method: 'eth_chainId' });
  if (typeof chain !== 'string' || !/^0x[0-9a-fA-F]+$/.test(chain) || BigInt(chain) !== BigInt(CHAIN_ID)) {
    throw new WalletCheckError('钱包网络不是指定的历史测试网络（链 ID 11155111）。请切换后重新连接。');
  }
}
export async function connect(injected: InjectedProvider): Promise<Connection> {
  await assertSepolia(injected);
  const accounts = await injected.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') throw new WalletCheckError('钱包没有返回授权账户。');
  await assertSepolia(injected);
  return { injected, provider: new BrowserProvider(injected, 'any'), account: getAddress(accounts[0]) };
}
export async function assertAccount(connection: Connection): Promise<void> {
  await assertSepolia(connection.injected);
  const accounts = await connection.injected.request({ method: 'eth_accounts' });
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || getAddress(accounts[0]) !== connection.account) throw new WalletCheckError('钱包账户已变化，请重新连接并核验。');
}

export async function verifyDeployment(connection: Connection, config: Deployment): Promise<void> {
  await assertAccount(connection);
  const { provider } = connection;
  const codeEntries = [
    [config.factory_address, config.code_hashes.factory], [config.token_address, config.code_hashes.token],
    [config.reward_vault_address, config.code_hashes.reward_vault], [config.public_fund_address, config.code_hashes.public_fund],
  ];
  for (const [target, expected] of codeEntries) {
    const code = await provider.getCode(target);
    if (code === '0x' || keccak256(code) !== expected) throw new WalletCheckError(`合约运行时代码与可信部署配置不一致：${target}`);
  }
  const token = new Contract(config.token_address, TOKEN_ABI, provider);
  const factory = new Contract(config.factory_address, FACTORY_ABI, provider);
  const reward = new Contract(config.reward_vault_address, REWARDS_ABI, provider);
  const fund = new Contract(config.public_fund_address, ['function token() view returns (address)'], provider);
  const [decimals, supply, symbol, factoryToken, factoryRewards, factoryFund, vaultToken, fundToken, genesis] = await Promise.all([
    token.decimals(), token.totalSupply(), token.symbol(), factory.token(), factory.rewards(), factory.publicFund(), reward.token(), fund.token(), reward.genesis(),
  ]);
  if (decimals !== 18n || supply !== TOTAL_SUPPLY || symbol !== 'tHEYUNA') throw new WalletCheckError('链上代币小数位、供应量或符号不匹配。');
  if ([factoryToken, vaultToken, fundToken].some((value) => getAddress(value) !== config.token_address)
    || getAddress(factoryRewards) !== config.reward_vault_address || getAddress(factoryFund) !== config.public_fund_address || genesis !== BigInt(config.genesis)) {
    throw new WalletCheckError('部署工厂、资金库、代币或创世时间不匹配。');
  }
}

export function validateClaimIdentity(bundle: Bundle, config: Deployment, claim: Claim, account: string): void {
  if (bundle.manifest.chain_id !== config.chain_id || bundle.manifest.reward_vault !== config.reward_vault_address) throw new WalletCheckError('分配清单不属于此部署。');
  const known = bundle.claims.find((row) => row.index === claim.index);
  if (!known || JSON.stringify(known) !== JSON.stringify(claim) || claim.epoch !== bundle.manifest.epoch || getAddress(claim.recipient) !== getAddress(account)) throw new WalletCheckError('领取证明不属于当前钱包或分配清单。');
  if (!verifyProof(CHAIN_ID, config.reward_vault_address, claim, bundle.root)) throw new WalletCheckError('领取证明已失效或被修改。');
}
async function validateOnChain(connection: Connection, config: Deployment, bundle: Bundle, claim: Claim): Promise<void> {
  validateClaimIdentity(bundle, config, claim, connection.account);
  await verifyDeployment(connection, config);
  const reward = new Contract(config.reward_vault_address, REWARDS_ABI, connection.provider);
  const [epoch, paused, claimed] = await Promise.all([reward.epochs(claim.epoch), reward.paused(), reward.isClaimed(claim.epoch, claim.index)]);
  verifyEpoch(bundle, epoch as Epoch);
  if (paused) throw new WalletCheckError('奖励库已暂停，暂时不能领取。');
  if (claimed) throw new WalletCheckError('此条奖励已在链上领取。');
}
export async function prepareClaim(connection: Connection, config: Deployment, bundle: Bundle, claim: Claim): Promise<Quote> {
  await validateOnChain(connection, config, bundle, claim);
  const data = rewardsInterface.encodeFunctionData('claim', [claim.epoch, claim.index, claim.recipient, claim.kind, claim.amount, claim.proof]);
  const gasEstimate = await connection.provider.estimateGas({ from: connection.account, to: config.reward_vault_address, data, value: 0n });
  const gasLimit = (gasEstimate * 120n + 99n) / 100n;
  if (gasLimit > 1_000_000n) throw new WalletCheckError('费用估算异常，停止发送。');
  const fees = await connection.provider.getFeeData();
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
  if (!maxFeePerGas || maxFeePerGas <= 0n) throw new WalletCheckError('暂时无法估算网络费用，请重试。');
  const maxPriorityFeePerGas = fees.maxFeePerGas ? fees.maxPriorityFeePerGas : null;
  if (fees.maxFeePerGas && maxPriorityFeePerGas === null) throw new WalletCheckError('钱包未提供完整的 EIP-1559 费用估算。');
  return { account: connection.account, claim, data, gasLimit, gasEstimate, maxFeePerGas, maxPriorityFeePerGas,
    maximumFee: gasLimit * maxFeePerGas, preparedAt: Date.now(), manifestHash: bundle.manifestHash, root: bundle.root };
}
export function assertFreshQuote(quote: Quote, now = Date.now()): void {
  if (now < quote.preparedAt || now - quote.preparedAt > 120_000) throw new WalletCheckError('费用预览已过期，请重新核验并预览。');
}
// The ONLY transaction-send path. The UI calls it only on the separate explicit confirmation button.
export async function sendClaim(connection: Connection, config: Deployment, bundle: Bundle, quote: Quote): Promise<string> {
  assertFreshQuote(quote);
  if (quote.account !== connection.account || quote.manifestHash !== bundle.manifestHash || quote.root !== bundle.root) throw new WalletCheckError('领取预览已失效。');
  await validateOnChain(connection, config, bundle, quote.claim);
  await assertAccount(connection);
  const data = rewardsInterface.encodeFunctionData('claim', [quote.claim.epoch, quote.claim.index, quote.claim.recipient, quote.claim.kind, quote.claim.amount, quote.claim.proof]);
  if (data !== quote.data) throw new WalletCheckError('交易内容与已预览内容不一致。');
  assertFreshQuote(quote);
  const transaction: Record<string, string> = {
    from: connection.account, to: config.reward_vault_address, data, value: '0x0', chainId: toQuantity(CHAIN_ID), gas: toQuantity(quote.gasLimit),
  };
  if (quote.maxPriorityFeePerGas !== null) {
    transaction.maxFeePerGas = toQuantity(quote.maxFeePerGas);
    transaction.maxPriorityFeePerGas = toQuantity(quote.maxPriorityFeePerGas);
  } else transaction.gasPrice = toQuantity(quote.maxFeePerGas);
  const txHash = await connection.injected.request({ method: 'eth_sendTransaction', params: [transaction] });
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new WalletCheckError('钱包未返回有效交易 hash，请先在钱包中核对是否已发送。');
  return txHash;
}

export type ReceiptEvidence = { status: number | null; to: string | null; from: string; logs: readonly { address: string; topics: readonly string[]; data: string }[] };
export function verifyReceipt(receipt: ReceiptEvidence, config: Deployment, quote: Quote): void {
  if (receipt.status !== 1 || !receipt.to || getAddress(receipt.to) !== config.reward_vault_address || getAddress(receipt.from) !== quote.account) throw new WalletCheckError('交易回执失败或不属于预览的领取交易。');
  const found = receipt.logs.some((log) => {
    if (getAddress(log.address) !== config.reward_vault_address) return false;
    try {
      const event = rewardsInterface.parseLog({ topics: [...log.topics], data: log.data });
      return event?.name === 'RewardClaimed' && event.args.epoch === BigInt(quote.claim.epoch) && event.args.index === BigInt(quote.claim.index)
        && getAddress(event.args.recipient) === quote.claim.recipient && event.args.kind === BigInt(quote.claim.kind) && event.args.amount === BigInt(quote.claim.amount);
    } catch { return false; }
  });
  if (!found) throw new WalletCheckError('回执中没有匹配的 RewardClaimed 事件。');
}
export async function waitForConfirmation(connection: Connection, config: Deployment, quote: Quote, txHash: string): Promise<TransactionReceipt> {
  await assertSepolia(connection.injected);
  const receipt = await connection.provider.waitForTransaction(txHash, config.confirmations, 180_000);
  if (!receipt) throw new WalletCheckError('等待确认超时。请保留交易 hash，稍后查询，不要直接重复发送。');
  await assertSepolia(connection.injected);
  verifyReceipt(receipt, config, quote);
  const block = await connection.provider.getBlock(receipt.blockNumber);
  if (!block || block.hash !== receipt.blockHash) throw new WalletCheckError('检测到区块变化，需要重新确认交易。');
  const reward = new Contract(config.reward_vault_address, REWARDS_ABI, connection.provider);
  if (!(await reward.isClaimed(quote.claim.epoch, quote.claim.index))) throw new WalletCheckError('领取状态与交易回执不一致。');
  return receipt;
}
