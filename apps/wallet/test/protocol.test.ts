import { describe, expect, it, vi } from 'vitest';
import { BrowserProvider, FeeData, Interface, keccak256 } from 'ethers';
import vector from '../../../contracts/fixtures/manifest-v1.json';
import { CHAIN_ID, TOTAL_SUPPLY, parseBundle, parseDeployment, verifyEpoch, type Deployment } from '../src/protocol';
import { assertAccount, assertFreshQuote, assertSepolia, connect, prepareClaim, rewardsInterface, sendClaim, validateClaimIdentity, verifyDeployment, verifyReceipt, type Connection, type InjectedProvider, type Quote } from '../src/wallet';

const code = '0x6000';
const config = parseDeployment({ version: 1, chain_id: CHAIN_ID, factory_address: '0x0000000000000000000000000000000000002000',
  token_address: '0x0000000000000000000000000000000000002001', reward_vault_address: vector.manifest.reward_vault,
  public_fund_address: '0x0000000000000000000000000000000000002002', genesis: 1900000000, decimals: 18, total_supply: TOTAL_SUPPLY.toString(), confirmations: 3,
  code_hashes: { factory: keccak256(code), token: keccak256(code), reward_vault: keccak256(code), public_fund: keccak256(code) } });
const bundle = parseBundle(JSON.stringify(vector), config);
const claim = bundle.claims[0];
const account = claim.recipient;
const quote = (): Quote => ({ account, claim, data: rewardsInterface.encodeFunctionData('claim', [claim.epoch, claim.index, claim.recipient, claim.kind, claim.amount, claim.proof]),
  gasLimit: 100000n, gasEstimate: 80000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, maximumFee: 1000000n, preparedAt: Date.now(), manifestHash: bundle.manifestHash, root: bundle.root });
function changed(mutator: (value: typeof vector) => void) { const copy = structuredClone(vector); mutator(copy); return JSON.stringify(copy); }

describe('deployment and manifest trust boundary', () => {
  it('requires independent nonempty public deployment configuration', () => {
    expect(() => parseDeployment({ ...config, token_address: null })).toThrow(/尚未配置/);
    expect(() => parseDeployment({ ...config, chain_id: 1 })).toThrow(/Sepolia/);
    expect(() => parseDeployment({ ...config, decimals: 6 })).toThrow(/小数位/);
    expect(() => parseDeployment({ ...config, total_supply: '20000000' })).toThrow(/供应量/);
    expect(() => parseDeployment({ ...config, code_hashes: { ...config.code_hashes, token: null } })).toThrow(/摘要/);
    expect(() => parseDeployment({ ...config, confirmations: 2 })).toThrow(/确认数/);
  });
  it('accepts the contracts package canonical manifest and proof vector', () => {
    expect(bundle.manifestHash).toBe(vector.manifestHash);
    expect(bundle.root).toBe(vector.root);
    expect(bundle.trainingAmount).toBe(100000000000000000000n);
    expect(bundle.claims).toEqual(vector.claims);
  });
  it('rejects network, address, manifest hash, amount, index and proof tampering', () => {
    expect(() => parseBundle(changed((v) => { v.manifest.chain_id = 1; }), config)).toThrow(/网络/);
    expect(() => parseBundle(changed((v) => { v.manifest.reward_vault = config.token_address; }), config)).toThrow(/奖励库/);
    expect(() => parseBundle(changed((v) => { v.manifestHash = `0x${'01'.repeat(32)}`; }), config)).toThrow(/摘要不匹配/);
    expect(() => parseBundle(changed((v) => { v.manifest.allocations[0].amount = '2'; }), config)).toThrow(/摘要不匹配/);
    expect(() => parseBundle(changed((v) => { v.claims[0].amount = '2'; }), config)).toThrow(/金额/);
    expect(() => parseBundle(changed((v) => { v.manifest.allocations[1].index = '0'; }), config)).toThrow(/重复/);
    expect(() => parseBundle(changed((v) => { v.claims[0].proof[0] = `0x${'01'.repeat(32)}`; }), config)).toThrow(/Merkle/);
  });
  it('rejects numbers instead of exact decimal strings and incomplete proof sets', () => {
    const copy = structuredClone(vector) as unknown as { manifest: { allocations: { amount: unknown }[] }; claims: unknown[] };
    copy.manifest.allocations[0].amount = 1e20;
    expect(() => parseBundle(JSON.stringify(copy), config)).toThrow(/十进制字符串/);
    expect(() => parseBundle(changed((v) => { v.claims.pop(); }), config)).toThrow(/一一对应/);
  });
  it('requires a finalized on-chain epoch with matching root, manifest and category sums', () => {
    const epoch = { root: bundle.root, manifestHash: bundle.manifestHash, trainingAmount: bundle.trainingAmount, validationAmount: bundle.validationAmount, state: 2n };
    expect(() => verifyEpoch(bundle, epoch)).not.toThrow();
    expect(() => verifyEpoch(bundle, { ...epoch, state: 1n })).toThrow(/最终确认/);
    expect(() => verifyEpoch(bundle, { ...epoch, manifestHash: `0x${'01'.repeat(32)}` })).toThrow(/摘要/);
    expect(() => verifyEpoch(bundle, { ...epoch, trainingAmount: 1n })).toThrow(/总额/);
  });
  it('binds a quote to the connected recipient and expires after two minutes', () => {
    expect(() => validateClaimIdentity(bundle, config, claim, account)).not.toThrow();
    expect(() => validateClaimIdentity(bundle, config, claim, config.token_address)).toThrow(/当前钱包/);
    const q = quote();
    expect(() => assertFreshQuote(q, q.preparedAt + 120001)).toThrow(/过期/);
    expect(() => assertFreshQuote(q, q.preparedAt - 1)).toThrow(/过期/);
  });
});

const mockInterface = new Interface([
  'function token() view returns (address)', 'function rewards() view returns (address)', 'function publicFund() view returns (address)',
  'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)', 'function symbol() view returns (string)',
  'function genesis() view returns (uint256)', 'function paused() view returns (bool)', 'function isClaimed(uint256,uint256) view returns (bool)',
  'function epochs(uint256) view returns (bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint8)',
]);
function mockConnection(options: { chain?: string; decimals?: bigint; claimed?: boolean; runtime?: string; accounts?: string[] } = {}) {
  const calls: { method: string; params?: unknown }[] = [];
  const injected: InjectedProvider = { async request(request) {
    calls.push(request);
    switch (request.method) {
      case 'eth_chainId': return options.chain ?? '0xaa36a7';
      case 'eth_accounts': case 'eth_requestAccounts': return options.accounts ?? [account];
      case 'eth_getCode': return options.runtime ?? code;
      case 'eth_call': {
        const tx = (request.params as { data: string }[])[0];
        const call = mockInterface.parseTransaction({ data: tx.data });
        if (!call) throw new Error('Unknown fixture call');
        const values: Record<string, unknown[]> = {
          token: [config.token_address], rewards: [config.reward_vault_address], publicFund: [config.public_fund_address], decimals: [options.decimals ?? 18n],
          totalSupply: [TOTAL_SUPPLY], symbol: ['tHEYUNA'], genesis: [BigInt(config.genesis)], paused: [false], isClaimed: [options.claimed ?? false],
          epochs: [bundle.root, bundle.manifestHash, bundle.trainingAmount, bundle.validationAmount, 0n, 0n, 0n, 0n, 2n],
        };
        return mockInterface.encodeFunctionResult(call.name, values[call.name]);
      }
      case 'eth_sendTransaction': return `0x${'fe'.repeat(32)}`;
      default: throw new Error(`Unsupported fixture method ${request.method}`);
    }
  } };
  const connection: Connection = { injected, provider: new BrowserProvider(injected, 'any'), account };
  return { connection, calls };
}

describe('wallet transaction boundary', () => {
  it('rejects wrong chain before even requesting accounts; connection never sends a transaction', async () => {
    const wrong = mockConnection({ chain: '0x1' });
    await expect(connect(wrong.connection.injected)).rejects.toThrow(/不是 Ethereum Sepolia/);
    expect(wrong.calls.map((call) => call.method)).toEqual(['eth_chainId']);
    wrong.connection.provider.destroy();
    const right = mockConnection();
    const connected = await connect(right.connection.injected);
    expect(connected.account).toBe(account);
    expect(right.calls.some((call) => call.method.includes('send') || call.method.includes('sign'))).toBe(false);
    connected.provider.destroy(); right.connection.provider.destroy();
  });
  it('rejects changed account and malformed chain response', async () => {
    const changedAccount = mockConnection({ accounts: [config.token_address] });
    await expect(assertAccount(changedAccount.connection)).rejects.toThrow(/账户已变化/);
    changedAccount.connection.provider.destroy();
    const malformed = mockConnection({ chain: '11155111' });
    await expect(assertSepolia(malformed.connection.injected)).rejects.toThrow(/不是 Ethereum Sepolia/);
    malformed.connection.provider.destroy();
  });
  it('verifies runtime bytecode, token parameters and immutable contract links without signing', async () => {
    const good = mockConnection();
    await expect(verifyDeployment(good.connection, config)).resolves.toBeUndefined();
    expect(good.calls.some((call) => call.method === 'eth_sendTransaction')).toBe(false);
    good.connection.provider.destroy();
    const wrongCode = mockConnection({ runtime: '0x6001' });
    await expect(verifyDeployment(wrongCode.connection, config)).rejects.toThrow(/运行时代码/);
    wrongCode.connection.provider.destroy();
    const wrongDecimals = mockConnection({ decimals: 6n });
    await expect(verifyDeployment(wrongDecimals.connection, config)).rejects.toThrow(/小数位/);
    wrongDecimals.connection.provider.destroy();
  });
  it('sends only a bound claim call with zero ETH value and the previewed fee cap', async () => {
    const good = mockConnection();
    const q = quote();
    await expect(sendClaim(good.connection, config, bundle, q)).resolves.toBe(`0x${'fe'.repeat(32)}`);
    const sends = good.calls.filter((call) => call.method === 'eth_sendTransaction');
    expect(sends).toHaveLength(1);
    const tx = (sends[0].params as Record<string, string>[])[0];
    expect(tx).toMatchObject({ from: account, to: config.reward_vault_address, chainId: '0xaa36a7', value: '0x0', data: q.data, maxFeePerGas: '0xa', maxPriorityFeePerGas: '0x1' });
    expect(rewardsInterface.parseTransaction({ data: tx.data })?.name).toBe('claim');
    good.connection.provider.destroy();
  });
  it('fee preview estimates only the claim, adds 20 percent gas headroom and never signs', async () => {
    const mock = mockConnection();
    const estimate = vi.spyOn(mock.connection.provider, 'estimateGas').mockResolvedValue(80000n);
    vi.spyOn(mock.connection.provider, 'getFeeData').mockResolvedValue(new FeeData(10n, 20n, 2n));
    const prepared = await prepareClaim(mock.connection, config, bundle, claim);
    expect(estimate).toHaveBeenCalledWith({ from: account, to: config.reward_vault_address, data: prepared.data, value: 0n });
    expect(prepared.gasLimit).toBe(96000n);
    expect(prepared.maximumFee).toBe(1920000n);
    expect(mock.calls.some((call) => call.method.includes('send') || call.method.includes('sign'))).toBe(false);
    estimate.mockResolvedValue(1_000_001n);
    await expect(prepareClaim(mock.connection, config, bundle, claim)).rejects.toThrow(/费用估算异常/);
    mock.connection.provider.destroy();
  });
  it('does not send expired, modified, already-claimed or wrong-chain requests', async () => {
    for (const [options, q] of [
      [{}, { ...quote(), preparedAt: Date.now() - 120001 }],
      [{}, { ...quote(), data: '0x' }],
      [{ claimed: true }, quote()],
      [{ chain: '0x1' }, quote()],
    ] as const) {
      const mock = mockConnection(options);
      await expect(sendClaim(mock.connection, config, bundle, q)).rejects.toThrow();
      expect(mock.calls.some((call) => call.method === 'eth_sendTransaction')).toBe(false);
      mock.connection.provider.destroy();
    }
  });
});

describe('receipt confirmation', () => {
  const event = rewardsInterface.encodeEventLog(rewardsInterface.getEvent('RewardClaimed')!, [claim.epoch, claim.index, claim.recipient, claim.kind, claim.amount]);
  const receipt = { status: 1, to: config.reward_vault_address, from: account, logs: [{ address: config.reward_vault_address, topics: event.topics, data: event.data }] };
  it('accepts only a successful matching claim event from the configured vault', () => {
    expect(() => verifyReceipt(receipt, config, quote())).not.toThrow();
    expect(() => verifyReceipt({ ...receipt, status: 0 }, config, quote())).toThrow(/回执失败/);
    expect(() => verifyReceipt({ ...receipt, logs: [] }, config, quote())).toThrow(/RewardClaimed/);
    expect(() => verifyReceipt({ ...receipt, to: config.token_address }, config, quote())).toThrow(/不属于/);
    const changedEvent = { ...receipt, logs: [{ ...receipt.logs[0], address: config.token_address }] };
    expect(() => verifyReceipt(changedEvent, config, quote())).toThrow(/RewardClaimed/);
  });
});
