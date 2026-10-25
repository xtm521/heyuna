// SPDX-License-Identifier: Apache-2.0
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { getAddress, keccak256, toUtf8Bytes } from 'ethers';

export const SEPOLIA_CHAIN_ID = 11155111;
export const TYPES = {
  RewardProposal: [
    { name: 'epoch', type: 'uint256' }, { name: 'root', type: 'bytes32' },
    { name: 'manifestHash', type: 'bytes32' }, { name: 'trainingAmount', type: 'uint256' },
    { name: 'validationAmount', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  CancelReward: [
    { name: 'epoch', type: 'uint256' }, { name: 'root', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' }, { name: 'reasonHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
  Unpause: [{ name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
  FundPayment: [
    { name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' },
    { name: 'descriptionHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  CancelPayment: [
    { name: 'paymentId', type: 'bytes32' }, { name: 'reasonHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export function domain(kind, verifyingContract, chainId = SEPOLIA_CHAIN_ID) {
  if (!['rewards', 'fund'].includes(kind)) throw new Error('Unknown signing domain');
  return { name: kind === 'rewards' ? 'HeyunaRewardVault' : 'HeyunaPublicFund', version: '1', chainId, verifyingContract: getAddress(verifyingContract) };
}

// Decimal strings prevent silent JS rounding of token base units. No user task/data content belongs here.
export function buildManifest({ chainId = SEPOLIA_CHAIN_ID, rewardVault, epoch, allocations }) {
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('Invalid chain ID');
  if ((typeof epoch === 'number' && !Number.isSafeInteger(epoch)) || !/^(0|[1-9][0-9]*)$/.test(String(epoch))) throw new Error('Epoch must be an exact nonnegative integer');
  if (!Array.isArray(allocations) || !allocations.length) throw new Error('No allocations');
  const indices = new Set();
  const normalized = allocations.map((row) => {
    if (typeof row.index !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.index) || indices.has(row.index)) throw new Error('Duplicate or invalid claim index');
    indices.add(row.index);
    if (typeof row.amount !== 'string' || !/^[1-9][0-9]*$/.test(row.amount)) throw new Error('Amount must be a positive base-unit string');
    if (![0, 1].includes(row.kind)) throw new Error('Claim kind must be 0 (training) or 1 (validation)');
    const recipient = getAddress(row.recipient);
    if (recipient === '0x0000000000000000000000000000000000000000' || recipient.toLowerCase() === rewardVault.toLowerCase()) throw new Error('Invalid recipient');
    return { index: row.index, recipient, kind: row.kind, amount: row.amount };
  }).sort((a, b) => BigInt(a.index) < BigInt(b.index) ? -1 : 1);
  const manifest = { version: 1, chain_id: chainId, reward_vault: getAddress(rewardVault), epoch: String(epoch), allocations: normalized };
  const serialized = JSON.stringify(manifest);
  const rows = normalized.map((row) => [chainId, manifest.reward_vault, manifest.epoch, row.index, row.recipient, row.kind, row.amount]);
  const tree = StandardMerkleTree.of(rows, ['uint256', 'address', 'uint256', 'uint256', 'address', 'uint8', 'uint256']);
  let training = 0n;
  let validation = 0n;
  for (const row of normalized) {
    if (row.kind === 0) training += BigInt(row.amount);
    else validation += BigInt(row.amount);
  }
  return {
    manifest, serialized, manifestHash: keccak256(toUtf8Bytes(serialized)), root: tree.root,
    trainingAmount: training, validationAmount: validation,
    claims: normalized.map((row, i) => ({ ...row, epoch: manifest.epoch, proof: tree.getProof(i) })),
  };
}
