// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccount, createAddressFromString } from '@ethereumjs/util';
import { getCreateAddress, TypedDataEncoder } from 'ethers';
import { makeChain, artifacts, interfaces, wallets, address, UNIT, WEEK, HASH } from './evm.mjs';
import { nativeManifest, nativeLeaf, ORACLE_ADDRESS, nativeFundDomain, NATIVE_PAYMENT_TYPES } from '../scripts/native-protocol.mjs';

const claimArgs = c => [c.epoch, c.index, c.recipient, c.category, c.amount, c.contributionId, c.proof];
const balance = async (f, a) => (await f.vm.stateManager.getAccount(createAddressFromString(a)))?.balance ?? 0n;
async function fixture() {
  const f = await makeChain(297012);
  const mock = await f.deploy('MockNativeOracle');
  await f.vm.stateManager.putAccount(createAddressFromString(ORACLE_ADDRESS), createAccount({ nonce: 1n }));
  await f.vm.stateManager.putCode(createAddressFromString(ORACLE_ADDRESS), await f.vm.stateManager.getCode(createAddressFromString(mock)));
  const vault = await f.deploy('NativeRewardVault');
  await f.transact(vault, '0x', wallets[0], 14_000_000n * UNIT);
  const allocations = [
    { index: 0, recipient: address(6), category: 0, amount: 100n * UNIT, contributionId: HASH },
    { index: 1, recipient: address(7), category: 1, amount: 10n * UNIT, contributionId: `0x${'cd'.repeat(32)}` },
  ];
  const manifest = nativeManifest({ chainId: f.chainId, rewardVault: vault, epoch: 0, allocations });
  const set = (root = manifest.root, training = manifest.trainingBudget, verification = manifest.verificationBudget, finalized = true, epoch = 0) =>
    f.send('MockNativeOracle', ORACLE_ADDRESS, 'setEpoch', [epoch, root, training, verification, finalized]);
  return { ...f, get now() { return f.now; }, vault, manifest, allocations, set };
}

test('native research vault disallows mainnet and exports no token mint, owner or upgrade API', async () => {
  const f = await makeChain(1);
  await assert.rejects(f.deploy('NativeRewardVault'), /UnsupportedChain/);
  for (const method of ['mint', 'burn', 'upgradeTo', 'transferOwnership', 'withdraw', 'setOracle']) {
    assert.equal(interfaces.NativeRewardVault.getFunction(method), null);
  }
});

test('native finalization and exact ABI leaf are required before a recipient can receive funds', async () => {
  const f = await fixture(); const c = f.manifest.claims[0];
  await f.set(undefined, undefined, undefined, false);
  await assert.rejects(f.send('NativeRewardVault', f.vault, 'claim', claimArgs(c)), /NotFinalized/);
  await f.set();
  assert.equal(nativeLeaf(f.chainId, f.vault, 0, c.category, c.index, c.recipient, c.amount, c.contributionId),
    nativeManifest({ chainId: f.chainId, rewardVault: f.vault, epoch: 0, allocations: [f.allocations[0]] }).root);
  const before = await balance(f, c.recipient);
  await f.send('NativeRewardVault', f.vault, 'claim', claimArgs(c), wallets[8]);
  assert.equal(await balance(f, c.recipient), before + BigInt(c.amount));
  assert.equal(await f.read('NativeRewardVault', f.vault, 'totalClaimed'), BigInt(c.amount));
  assert.equal(await f.read('NativeRewardVault', f.vault, 'isClaimed', [0, c.index]), true);
  await assert.rejects(f.send('NativeRewardVault', f.vault, 'claim', claimArgs(c)), /AlreadyClaimed/);
});

test('native proofs cannot redirect recipient, alter contribution/category/amount, or cross epoch/vault/chain', async () => {
  const f = await fixture(); await f.set(); const c = f.manifest.claims[0];
  for (const override of [{ recipient: address(8) }, { amount: String(BigInt(c.amount) + 1n) },
    { category: 1 }, { contributionId: `0x${'ef'.repeat(32)}` }]) {
    await assert.rejects(f.send('NativeRewardVault', f.vault, 'claim', claimArgs({ ...c, ...override })), /InvalidProof/);
  }
  await f.set(f.manifest.root, f.manifest.trainingBudget, f.manifest.verificationBudget, true, 1);
  await assert.rejects(f.send('NativeRewardVault', f.vault, 'claim', claimArgs({ ...c, epoch: 1 })), /InvalidProof/);
  const other = await f.deploy('NativeRewardVault');
  await assert.rejects(f.send('NativeRewardVault', other, 'claim', claimArgs(c)), /InvalidProof/);
  const wrong = nativeManifest({ chainId: 297011, rewardVault: f.vault, epoch: 0, allocations: f.allocations });
  await f.set(wrong.root);
  await assert.rejects(f.send('NativeRewardVault', f.vault, 'claim', claimArgs(wrong.claims[0])), /InvalidProof/);
});

test('native budget has 520 exact integer budgets and a bounded continuation ceiling', async () => {
  const f = await fixture(); let total = 0n; let largest = 0n;
  for (let i = 0; i < 520; i++) {
    const amount = await f.read('NativeRewardVault', f.vault, 'epochBudget', [i]);
    total += amount; if (amount > largest) largest = amount;
  }
  assert.equal(total, 14_000_000n * UNIT);
  assert.equal(await f.read('NativeRewardVault', f.vault, 'epochBudget', [520]), largest);
});

test('malicious oracle allocation cannot exceed either weekly category cap', async () => {
  const f = await fixture(); const cap = await f.read('NativeRewardVault', f.vault, 'epochBudget', [0]);
  for (const values of [[cap, 0n], [0n, cap]]) {
    await f.set(f.manifest.root, ...values);
    await assert.rejects(f.send('NativeRewardVault', f.vault, 'claim', claimArgs(f.manifest.claims[0])), /BudgetExceeded/);
  }
});

test('a root containing more leaves than its authorized total cannot overpay the epoch', async () => {
  const f = await fixture(); const c = f.allocations[0];
  const m = nativeManifest({ chainId: f.chainId, rewardVault: f.vault, epoch: 0,
    allocations: [c, { ...c, index: 2, contributionId: `0x${'fe'.repeat(32)}` }] });
  await f.set(m.root, c.amount, 0n);
  await f.send('NativeRewardVault', f.vault, 'claim', claimArgs(m.claims[0]));
  await assert.rejects(f.send('NativeRewardVault', f.vault, 'claim', claimArgs(m.claims[1])), /BudgetExceeded/);
});

test('native receive reentrancy cannot claim twice and failed transfers roll back claim accounting', async () => {
  const f = await fixture(); const receiver = await f.deploy('NativeReentrantReceiver');
  const m = nativeManifest({ chainId: f.chainId, rewardVault: f.vault, epoch: 0,
    allocations: [{ ...f.allocations[0], recipient: receiver }] });
  await f.set(m.root, m.trainingBudget, 0n);
  const data = interfaces.NativeRewardVault.encodeFunctionData('claim', claimArgs(m.claims[0]));
  await f.send('NativeReentrantReceiver', receiver, 'configure', [f.vault, data, true]);
  await assert.rejects(f.send('NativeRewardVault', f.vault, 'claim', claimArgs(m.claims[0])), /TransferFailed/);
  assert.equal(await f.read('NativeRewardVault', f.vault, 'isClaimed', [0, 0]), false);
  assert.equal(await f.read('NativeRewardVault', f.vault, 'totalClaimed'), 0n);
  await f.send('NativeReentrantReceiver', receiver, 'configure', [f.vault, data, false]);
  await f.send('NativeRewardVault', f.vault, 'claim', claimArgs(m.claims[0]));
  assert.equal(await f.read('NativeReentrantReceiver', receiver, 'reentrySucceeded'), false);
  assert.equal(await balance(f, receiver), m.trainingBudget);
});

test('native manifest builder rejects duplicate indices and unsupported network identities', () => {
  const a = { index: 0, recipient: address(6), category: 0, amount: 1n, contributionId: HASH };
  assert.throws(() => nativeManifest({ chainId: 1, rewardVault: address(0), epoch: 0, allocations: [a] }));
  assert.throws(() => nativeManifest({ chainId: 297012, rewardVault: address(0), epoch: 0, allocations: [a, a] }), /duplicate/);
});

async function fundFixture(donation = 0n) {
  const f = await makeChain(297012);
  const creator = await f.vm.stateManager.getAccount(createAddressFromString(address(0)));
  const fund = getCreateAddress({ from: address(0), nonce: creator.nonce + 1n });
  await f.transact(fund, '0x', wallets[0], 2_000_000n * UNIT);
  if (donation) await f.transact(fund, '0x', wallets[7], donation);
  const faucet = address(8); const members = wallets.slice(1, 6);
  const before = await balance(f, faucet);
  assert.equal(await f.deploy('NativePublicFund', [members.map(w => w.address), faucet]), fund);
  assert.equal(await balance(f, faucet), before + 100_000n * UNIT);
  assert.equal(await balance(f, fund), 1_900_000n * UNIT + donation);
  return { ...f, get now() { return f.now; }, fund, members };
}
async function payment(f, signers = f.members.slice(0, 3), overrides = {}, domainOverride = {}) {
  const value = { recipient: address(7), amount: 25n * UNIT, descriptionHash: HASH,
    nonce: await f.read('NativePublicFund', f.fund, 'nextNonce'), deadline: f.now + WEEK, ...overrides };
  const domain = { ...nativeFundDomain(f.chainId, f.fund), ...domainOverride };
  const pairs = await Promise.all(signers.map(async w => ({ address: w.address.toLowerCase(),
    signature: await w.signTypedData(domain, NATIVE_PAYMENT_TYPES, value) })));
  pairs.sort((a, b) => a.address.localeCompare(b.address));
  return { value, id: TypedDataEncoder.hash(domain, NATIVE_PAYMENT_TYPES, value),
    args: [value.recipient, value.amount, value.descriptionHash, value.deadline, pairs.map(p => p.signature)] };
}

test('native fund uses 3 of 5, exact prefunding, explicit faucet grant and immutable seven-day delay', async () => {
  const f = await fundFixture();
  assert.equal(await f.read('NativePublicFund', f.fund, 'THRESHOLD'), 3n);
  assert.equal(await f.read('NativePublicFund', f.fund, 'EXECUTION_DELAY'), WEEK);
  for (const signers of [f.members.slice(0, 2), [f.members[0], f.members[0], f.members[1]], [...f.members.slice(0, 2), wallets[8]]]) {
    const p = await payment(f, signers);
    await assert.rejects(f.send('NativePublicFund', f.fund, 'queuePayment', p.args), /InvalidQuorum/);
  }
  const p = await payment(f);
  await f.send('NativePublicFund', f.fund, 'queuePayment', p.args);
  await assert.rejects(f.send('NativePublicFund', f.fund, 'executePayment', [p.id]), /TimelockActive/);
  const before = await balance(f, p.value.recipient);
  f.advance(WEEK);
  await f.send('NativePublicFund', f.fund, 'executePayment', [p.id], wallets[8]);
  assert.equal(await balance(f, p.value.recipient), before + p.value.amount);
  await assert.rejects(f.send('NativePublicFund', f.fund, 'executePayment', [p.id]), /WrongState/);
});

test('an unsolicited base-unit donation cannot brick a prefunded future treasury address', async () => {
  const f = await fundFixture(1n);
  assert.equal(await balance(f, f.fund), 1_900_000n * UNIT + 1n);
  const chain = await makeChain(297012);
  await assert.rejects(chain.deploy('NativePublicFund', [wallets.slice(1, 6).map(w => w.address), wallets[8].address]));
});

test('native treasury rejects signature replay/domain tampering and prevents reserve overcommit', async () => {
  const f = await fundFixture(); const p = await payment(f);
  const wrong = await payment(f, undefined, {}, { chainId: 297011 });
  await assert.rejects(f.send('NativePublicFund', f.fund, 'queuePayment', wrong.args), /InvalidQuorum/);
  await f.send('NativePublicFund', f.fund, 'queuePayment', p.args);
  await assert.rejects(f.send('NativePublicFund', f.fund, 'queuePayment', p.args), /InvalidQuorum/);
  const excessive = await payment(f, undefined, { amount: 1_900_000n * UNIT });
  await assert.rejects(f.send('NativePublicFund', f.fund, 'queuePayment', excessive.args), /InsufficientUnreservedFunds/);
});
