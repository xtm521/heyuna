// SPDX-License-Identifier: Apache-2.0
import { AbiCoder, concat, getAddress, keccak256, toUtf8Bytes } from 'ethers';

export const CHAIN_ID = 11155111;
export const TOTAL_SUPPLY = 20_000_000n * 10n ** 18n;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const UINT_MAX = (1n << 256n) - 1n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
type RecordValue = Record<string, unknown>;
export type Allocation = { index: string; recipient: string; kind: 0 | 1; amount: string };
export type Claim = Allocation & { epoch: string; proof: string[] };
export type Manifest = { version: 1; chain_id: number; reward_vault: string; epoch: string; allocations: Allocation[] };
export type Bundle = { manifest: Manifest; manifestHash: string; root: string; claims: Claim[]; trainingAmount: bigint; validationAmount: bigint };
export type Deployment = {
  version: 1; chain_id: number; factory_address: string; token_address: string;
  reward_vault_address: string; public_fund_address: string; genesis: number; decimals: 18;
  total_supply: string; confirmations: number;
  code_hashes: { factory: string; token: string; reward_vault: string; public_fund: string };
};
export type Epoch = { root: string; manifestHash: string; trainingAmount: bigint; validationAmount: bigint; state: bigint };

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 对象格式无效。');
  return value as RecordValue;
}
export function uint(value: unknown, label: string, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} 必须为精确的十进制字符串。`);
  const parsed = BigInt(value);
  if (parsed > UINT_MAX || (positive && parsed === 0n)) throw new Error(`${label} 超出有效范围。`);
  return value;
}
export function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('摘要或证明必须为 32 字节十六进制值。');
  return value.toLowerCase();
}
export function address(value: unknown): string {
  if (typeof value !== 'string') throw new Error('部署地址尚未配置。');
  const parsed = getAddress(value);
  if (parsed === ZERO_ADDRESS) throw new Error('不能使用零地址。');
  return parsed;
}
export function parseDeployment(input: unknown): Deployment {
  const raw = record(input);
  if (raw.chain_id !== CHAIN_ID) throw new Error('部署配置必须为 Ethereum Sepolia（11155111）。');
  if (raw.version !== 1 || raw.decimals !== 18 || raw.total_supply !== TOTAL_SUPPLY.toString()) throw new Error('部署协议版本、小数位或供应量不匹配。');
  const factory_address = address(raw.factory_address);
  const token_address = address(raw.token_address);
  const reward_vault_address = address(raw.reward_vault_address);
  const public_fund_address = address(raw.public_fund_address);
  if (new Set([factory_address, token_address, reward_vault_address, public_fund_address]).size !== 4) throw new Error('部署地址必须互不相同。');
  if (!Number.isSafeInteger(raw.genesis) || Number(raw.genesis) <= 0) throw new Error('创世时间无效。');
  if (!Number.isSafeInteger(raw.confirmations) || Number(raw.confirmations) < 3 || Number(raw.confirmations) > 64) throw new Error('确认数必须介于 3 与 64 之间。');
  const codes = record(raw.code_hashes);
  const code_hashes = { factory: hash(codes.factory), token: hash(codes.token), reward_vault: hash(codes.reward_vault), public_fund: hash(codes.public_fund) };
  if (Object.values(code_hashes).some((value) => /^0x0{64}$/.test(value))) throw new Error('运行时代码摘要尚未配置。');
  return { version: 1, chain_id: CHAIN_ID, factory_address, token_address, reward_vault_address, public_fund_address,
    genesis: Number(raw.genesis), decimals: 18, total_supply: raw.total_supply, confirmations: Number(raw.confirmations), code_hashes };
}

function allocation(input: unknown, vault: string): Allocation {
  const raw = record(input);
  const recipient = address(raw.recipient);
  if (recipient === vault) throw new Error('奖励不能支付给奖励库自身。');
  if (raw.kind !== 0 && raw.kind !== 1) throw new Error('贡献类别必须为训练（0）或验证（1）。');
  return { index: uint(raw.index, '领取索引'), recipient, kind: raw.kind, amount: uint(raw.amount, '奖励金额', true) };
}

export function claimLeaf(chainId: number, vault: string, claim: Claim): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint256', 'uint256', 'address', 'uint8', 'uint256'],
    [chainId, vault, claim.epoch, claim.index, claim.recipient, claim.kind, claim.amount]);
  return keccak256(keccak256(encoded));
}
export function verifyProof(chainId: number, vault: string, claim: Claim, root: string): boolean {
  let node = claimLeaf(chainId, vault, claim);
  for (const sibling of claim.proof) node = keccak256(BigInt(node) < BigInt(sibling) ? concat([node, sibling]) : concat([sibling, node]));
  return node.toLowerCase() === root.toLowerCase();
}

export function parseBundle(text: string, deployment: Deployment): Bundle {
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) throw new Error('分配清单不能超过 5 MiB。');
  const raw = record(JSON.parse(text));
  const data = record(raw.manifest);
  if (data.version !== 1 || data.chain_id !== deployment.chain_id || address(data.reward_vault) !== deployment.reward_vault_address) throw new Error('清单的网络、协议或奖励库与部署配置不一致。');
  if (!Array.isArray(data.allocations) || data.allocations.length === 0 || data.allocations.length > 10_000) throw new Error('清单需包含 1 至 10,000 条分配。');
  const allocations = data.allocations.map((row) => allocation(row, deployment.reward_vault_address)).sort((a, b) => BigInt(a.index) < BigInt(b.index) ? -1 : 1);
  if (new Set(allocations.map((row) => row.index)).size !== allocations.length) throw new Error('存在重复的领取索引。');
  const manifest: Manifest = { version: 1, chain_id: CHAIN_ID, reward_vault: deployment.reward_vault_address, epoch: uint(data.epoch, '周期编号'), allocations };
  const manifestHash = hash(raw.manifestHash);
  if (keccak256(toUtf8Bytes(JSON.stringify(manifest))) !== manifestHash) throw new Error('分配清单摘要不匹配，文件可能被修改。');
  const root = hash(raw.root);
  if (!Array.isArray(raw.claims) || raw.claims.length !== allocations.length) throw new Error('证明条目必须与分配条目一一对应。');
  const rows = new Map(allocations.map((row) => [row.index, row]));
  const claims = raw.claims.map((input) => {
    const entry = record(input);
    const row = allocation(entry, deployment.reward_vault_address);
    const original = rows.get(row.index);
    if (!original || JSON.stringify(row) !== JSON.stringify(original) || entry.epoch !== manifest.epoch) throw new Error('领取证明的收款人、金额、类别或周期与清单不一致。');
    rows.delete(row.index);
    if (!Array.isArray(entry.proof) || entry.proof.length > 64) throw new Error('Merkle 证明格式无效。');
    const claim: Claim = { ...row, epoch: manifest.epoch, proof: entry.proof.map(hash) };
    if (!verifyProof(CHAIN_ID, deployment.reward_vault_address, claim, root)) throw new Error('Merkle 证明校验失败。');
    return claim;
  });
  const trainingAmount = allocations.filter((row) => row.kind === 0).reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const validationAmount = allocations.filter((row) => row.kind === 1).reduce((sum, row) => sum + BigInt(row.amount), 0n);
  if (trainingAmount > 16_200_000n * 10n ** 18n || validationAmount > 1_800_000n * 10n ** 18n) throw new Error('清单超出协议累计额度。');
  return { manifest, manifestHash, root, claims, trainingAmount, validationAmount };
}

export function verifyEpoch(bundle: Bundle, epoch: Epoch): void {
  if (epoch.state !== 2n) throw new Error('本周期尚未完成链上最终确认。');
  if (hash(epoch.root) !== bundle.root || hash(epoch.manifestHash) !== bundle.manifestHash) throw new Error('链上根或清单摘要不匹配。');
  if (epoch.trainingAmount !== bundle.trainingAmount || epoch.validationAmount !== bundle.validationAmount) throw new Error('链上类别总额与公开清单不一致。');
}
