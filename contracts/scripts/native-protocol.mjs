// SPDX-License-Identifier: Apache-2.0
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { AbiCoder, keccak256, getAddress } from 'ethers';
import { createHash } from 'node:crypto';

export const NATIVE_CHAIN_IDS = [297011, 297012];
export const ORACLE_ADDRESS = getAddress('0x0000000000000000000000000000000000000900');
export const FACTORY_ADDRESS = getAddress('0x0000000000000000000000000000000000000f01');
export const LEAF_TYPES = ['uint256', 'address', 'uint256', 'uint8', 'uint256', 'address', 'uint256', 'bytes32'];

export function nativeManifest({ chainId, rewardVault, epoch, allocations }) {
  if (!NATIVE_CHAIN_IDS.includes(Number(chainId))) throw new Error('unsupported research chain');
  const seen = new Set();
  const values = allocations.map(a => {
    const index = BigInt(a.index).toString();
    if (seen.has(index)) throw new Error('duplicate epoch index');
    seen.add(index);
    if (![0, 1].includes(Number(a.category)) || BigInt(a.amount) <= 0n) throw new Error('invalid allocation');
    return [BigInt(chainId).toString(), getAddress(rewardVault), BigInt(epoch).toString(),
      Number(a.category), index, getAddress(a.recipient), BigInt(a.amount).toString(), a.contributionId];
  });
  if (!values.length) throw new Error('empty allocation');
  const tree = StandardMerkleTree.of(values, LEAF_TYPES);
  const claims = values.map((value, index) => ({ epoch: value[2], category: value[3], index: value[4],
    recipient: value[5], amount: value[6], contributionId: value[7], proof: tree.getProof(index) }));
  return { version: 2, chain_id: Number(chainId), asset_kind: 'native', reward_vault_address: getAddress(rewardVault),
    epoch: BigInt(epoch).toString(), root: tree.root,
    trainingBudget: values.filter(v => v[3] === 0).reduce((n, v) => n + BigInt(v[6]), 0n),
    verificationBudget: values.filter(v => v[3] === 1).reduce((n, v) => n + BigInt(v[6]), 0n), claims };
}

export function nativeLeaf(chainId, vault, epoch, category, index, recipient, amount, contributionId) {
  return keccak256(keccak256(AbiCoder.defaultAbiCoder().encode(LEAF_TYPES,
    [chainId, vault, epoch, category, index, recipient, amount, contributionId])));
}

export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Version two is deliberately incompatible with the legacy ERC-20 bundle. */
export function nativeBundle({ chainId, genesisHash, rewardVault, epoch, allocations }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(genesisHash) || BigInt(genesisHash) === 0n) throw new Error('invalid genesis hash');
  const normalized = allocations.map(a => {
    const contribution = a.contribution_id ?? a.contributionId;
    if (!/^0x[0-9a-fA-F]{64}$/.test(contribution) || BigInt(contribution) === 0n) throw new Error('invalid contribution id');
    if (BigInt(a.index) < 0n || BigInt(a.index) >= 2n ** 256n) throw new Error('invalid index');
    if (BigInt(a.amount) <= 0n || BigInt(a.amount) >= 2n ** 256n) throw new Error('invalid amount');
    const recipient = getAddress(a.recipient).toLowerCase();
    if (BigInt(recipient) === 0n) throw new Error('zero recipient');
    return { index: BigInt(a.index).toString(), recipient, category: Number(a.category),
      amount: BigInt(a.amount).toString(), contribution_id: contribution.toLowerCase() };
  }).sort((a, b) => BigInt(a.index) < BigInt(b.index) ? -1 : 1);
  const data = nativeManifest({ chainId, rewardVault, epoch, allocations: normalized.map(a => ({ ...a, contributionId: a.contribution_id })) });
  const manifest = { version: 2, asset_kind: 'native', chain_id: Number(chainId), genesis_hash: genesisHash.toLowerCase(),
    reward_vault: getAddress(rewardVault).toLowerCase(), epoch: BigInt(epoch).toString(), allocations: normalized };
  return { manifest, manifest_hash: createHash('sha256').update(canonicalJSON(manifest)).digest('hex'),
    root: data.root, training_budget: data.trainingBudget.toString(), verification_budget: data.verificationBudget.toString(),
    claims: data.claims.map(c => ({ epoch: c.epoch, index: c.index, recipient: c.recipient.toLowerCase(),
      category: c.category, amount: c.amount, contribution_id: c.contributionId.toLowerCase(), proof: c.proof })) };
}

export const NATIVE_PAYMENT_TYPES = { FundPayment: [
  { name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' },
  { name: 'descriptionHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] };
export const NATIVE_CANCEL_TYPES = { CancelPayment: [
  { name: 'paymentId', type: 'bytes32' }, { name: 'reasonHash', type: 'bytes32' }, { name: 'deadline', type: 'uint256' },
] };
export const nativeFundDomain = (chainId, verifyingContract) => ({ name: 'HeyunaNativePublicFund', version: '2', chainId, verifyingContract });
