// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { interfaces, makeChain, fixture, validators, managers, wallets, address, HASH,
  WEEK, CHALLENGE, UNIT, signed, manifest, proposal, propose, claimArgs, fundPayment } from './evm.mjs';
import { buildManifest } from '../scripts/protocol.mjs';

test('atomic deployment: exact fixed supply, 90/10 allocation, immutable token references', async () => {
  const f = await fixture();
  assert.equal(await f.read('HeyunaToken', f.token, 'totalSupply'), 20_000_000n * UNIT);
  assert.equal(await f.read('HeyunaToken', f.token, 'balanceOf', [f.rewards]), 18_000_000n * UNIT);
  assert.equal(await f.read('HeyunaToken', f.token, 'balanceOf', [f.fund]), 2_000_000n * UNIT);
  assert.equal(await f.read('HeyunaToken', f.token, 'balanceOf', [address(0)]), 0n);
  assert.equal(await f.read('HeyunaToken', f.token, 'decimals'), 18n);
  assert.equal(await f.read('HeyunaToken', f.token, 'symbol'), 'tHEYUNA');
  assert.equal(await f.read('RewardVault', f.rewards, 'token'), f.token);
  assert.equal(await f.read('PublicFund', f.fund, 'token'), f.token);
  for (const method of ['mint', 'burn', 'upgradeTo', 'transferOwnership', 'pause', 'setTax', 'blacklist']) {
    assert.equal(interfaces.HeyunaToken.getFunction(method), null);
  }
});

test('mainnet and non-approved chains are rejected by the deployment constructor', async () => {
  for (const chainId of [1, 10]) {
    const f = await makeChain(chainId);
    await assert.rejects(f.deploy('HeyunaTestnet', [validators.map((w) => w.address), managers.map((w) => w.address), f.now + 60n]), /UnsupportedChain/);
  }
});

test('Sepolia chain ID is accepted in local EVM simulation without making network calls', async () => {
  const f = await makeChain(11155111);
  const factory = await f.deploy('HeyunaTestnet', [validators.map((w) => w.address), managers.map((w) => w.address), f.now + 60n]);
  const token = await f.read('HeyunaTestnet', factory, 'token');
  assert.equal(await f.read('HeyunaToken', token, 'symbol'), 'tHEYUNA');
});

test('validators must be three distinct nonzero addresses; genesis cannot be in the past', async () => {
  const f = await makeChain();
  const good = validators.map((w) => w.address);
  await assert.rejects(f.deploy('HeyunaTestnet', [[good[0], good[0], good[2]], good, f.now + 60n]), /InvalidValidators/);
  await assert.rejects(f.deploy('HeyunaTestnet', [['0x0000000000000000000000000000000000000000', good[1], good[2]], good, f.now + 60n]), /InvalidValidators/);
  await assert.rejects(f.deploy('HeyunaTestnet', [good, good, f.now - 1n]), /InvalidAllocation/);
});

test('520 integer-difference epoch budgets sum to exactly 18m and tail cap does not grow', async () => {
  const f = await fixture();
  let total = 0n;
  let maximum = 0n;
  for (let epoch = 0; epoch < 520; epoch += 1) {
    const budget = await f.read('RewardVault', f.rewards, 'epochBudget', [epoch]);
    const categories = await f.read('RewardVault', f.rewards, 'categoryBudgets', [epoch]);
    assert.equal(categories.training + categories.validation, budget);
    assert.equal(categories.training, budget * 9n / 10n);
    total += budget;
    maximum = budget > maximum ? budget : maximum;
  }
  assert.equal(total, 18_000_000n * UNIT);
  for (const epoch of [520, 521, 10_000]) assert.equal(await f.read('RewardVault', f.rewards, 'epochBudget', [epoch]), maximum);
});

test('only completed current week is allocatable; missed epochs cannot accumulate or backfill', async () => {
  const f = await fixture();
  const m = manifest(f);
  await assert.rejects(propose(f, m), /InvalidEpoch/);
  f.at(f.genesis + WEEK);
  await assert.rejects(propose(f, manifest(f, 1n)), /InvalidEpoch/);
  f.at(f.genesis + 2n * WEEK);
  await assert.rejects(propose(f, m), /InvalidEpoch/);
  await propose(f, manifest(f, 1n));
});

test('proposal signatures require quorum, unique members, sorted identities and fresh deadlines', async () => {
  const f = await fixture();
  f.at(f.genesis + WEEK);
  const m = manifest(f);
  for (const members of [[validators[0]], [validators[0], validators[0]], [validators[0], wallets[8]]]) {
    const p = await proposal(f, m, {}, members);
    await assert.rejects(f.send('RewardVault', f.rewards, 'proposeEpoch', p.args), /InvalidQuorum/);
  }
  const p = await proposal(f, m);
  await assert.rejects(f.send('RewardVault', f.rewards, 'proposeEpoch', [...p.args.slice(0, -1), [...p.signatures].reverse()]), /InvalidQuorum/);
  const expired = await proposal(f, m, { deadline: f.now - 1n });
  await assert.rejects(f.send('RewardVault', f.rewards, 'proposeEpoch', expired.args), /SignatureExpired/);
  await propose(f, m);
});

test('EIP-712 rejects cross-chain and cross-vault replay and allocation tampering', async () => {
  const f = await fixture();
  f.at(f.genesis + WEEK);
  const m = manifest(f);
  for (const overrides of [{ chainId: 1 }, { verifyingContract: f.fund }]) {
    const p = await proposal(f, m, {}, validators.slice(0, 2), overrides);
    await assert.rejects(f.send('RewardVault', f.rewards, 'proposeEpoch', p.args), /InvalidQuorum/);
  }
  const p = await proposal(f, m);
  p.args[3] += 1n;
  await assert.rejects(f.send('RewardVault', f.rewards, 'proposeEpoch', p.args), /InvalidQuorum/);
});

test('per-week category ceilings reject excess and cannot borrow unused validation allocation', async () => {
  const f = await fixture();
  f.at(f.genesis + WEEK);
  const caps = await f.read('RewardVault', f.rewards, 'categoryBudgets', [0]);
  for (const overrides of [{ trainingAmount: caps.training + 1n }, { validationAmount: caps.validation + 1n }]) {
    const p = await proposal(f, manifest(f), overrides);
    await assert.rejects(f.send('RewardVault', f.rewards, 'proposeEpoch', p.args), /BudgetExceeded/);
  }
});

test('72-hour challenge window, public evidence and one-time finalization', async () => {
  const f = await fixture();
  f.at(f.genesis + WEEK);
  await propose(f);
  await assert.rejects(f.send('RewardVault', f.rewards, 'finalizeEpoch', [0]), /ChallengePeriodActive/);
  await f.send('RewardVault', f.rewards, 'reportChallenge', [0, HASH], wallets[8]);
  f.advance(CHALLENGE - 1n);
  await assert.rejects(f.send('RewardVault', f.rewards, 'finalizeEpoch', [0]), /ChallengePeriodActive/);
  f.advance(1n);
  await f.send('RewardVault', f.rewards, 'finalizeEpoch', [0]);
  await assert.rejects(propose(f), /WrongState/);
  await assert.rejects(f.send('RewardVault', f.rewards, 'finalizeEpoch', [0]), /WrongState/);
  await assert.rejects(f.send('RewardVault', f.rewards, 'cancelEpoch', [0, HASH, f.now + WEEK, []]), /WrongState/);
});

test('cancel releases reservations, increments proposal nonce and invalidates old signatures', async () => {
  const f = await fixture();
  f.at(f.genesis + WEEK);
  const m = manifest(f);
  const old = await propose(f, m);
  const value = { epoch: 0, root: m.root, nonce: 0, reasonHash: HASH, deadline: f.now + WEEK };
  const signatures = await signed(f, 'rewards', 'CancelReward', value, validators.slice(0, 2));
  await f.send('RewardVault', f.rewards, 'cancelEpoch', [0, HASH, value.deadline, signatures]);
  assert.equal(await f.read('RewardVault', f.rewards, 'totalAllocated'), 0n);
  await assert.rejects(f.send('RewardVault', f.rewards, 'proposeEpoch', old.args), /InvalidQuorum/);
  await propose(f, m);
  const entry = await f.read('RewardVault', f.rewards, 'epochs', [0]);
  assert.equal(entry.nonce, 1n);
});

test('claims are permissionless relays, cannot redirect, cannot repeat, and conserve supply', async () => {
  const f = await fixture();
  f.at(f.genesis + WEEK);
  const m = manifest(f);
  await propose(f, m);
  await assert.rejects(f.send('RewardVault', f.rewards, 'claim', claimArgs(m.claims[0])), /WrongState/);
  f.advance(CHALLENGE);
  await f.send('RewardVault', f.rewards, 'finalizeEpoch', [0]);
  const wrong = claimArgs(m.claims[0]);
  wrong[2] = address(8);
  await assert.rejects(f.send('RewardVault', f.rewards, 'claim', wrong), /InvalidProof/);
  for (const c of m.claims) {
    await f.send('RewardVault', f.rewards, 'claim', claimArgs(c), wallets[8]);
    assert.equal(await f.read('RewardVault', f.rewards, 'isClaimed', [c.epoch, c.index]), true);
    await assert.rejects(f.send('RewardVault', f.rewards, 'claim', claimArgs(c)), /AlreadyClaimed/);
  }
  assert.equal(await f.read('HeyunaToken', f.token, 'balanceOf', [address(6)]), 100n * UNIT);
  assert.equal(await f.read('HeyunaToken', f.token, 'balanceOf', [address(7)]), 10n * UNIT);
  assert.equal(await f.read('HeyunaToken', f.token, 'balanceOf', [address(8)]), 0n);
  assert.equal(await f.read('RewardVault', f.rewards, 'totalClaimed'), 110n * UNIT);
  assert.equal(await f.read('HeyunaToken', f.token, 'totalSupply'), 20_000_000n * UNIT);
});

test('Merkle claims bind network, vault, epoch, index, recipient, kind and amount', async () => {
  const f = await fixture();
  f.at(f.genesis + WEEK);
  const m = manifest(f);
  await propose(f, m);
  f.advance(CHALLENGE);
  await f.send('RewardVault', f.rewards, 'finalizeEpoch', [0]);
  for (const [position, value] of [[1, '2'], [2, address(8)], [3, 1], [4, '1']]) {
    const args = claimArgs(m.claims[0]);
    args[position] = value;
    await assert.rejects(f.send('RewardVault', f.rewards, 'claim', args), /InvalidProof/);
  }
  const args = claimArgs(m.claims[0]); args[0] = 1;
  await assert.rejects(f.send('RewardVault', f.rewards, 'claim', args), /WrongState/);
  // Merkle leaf includes vault and chain; a tree built for another network cannot be claimed.
  const bad = buildManifest({ chainId: 1, rewardVault: f.rewards, epoch: 1, allocations: m.manifest.allocations });
  f.at(f.genesis + 2n * WEEK);
  await propose(f, bad);
  f.advance(CHALLENGE);
  await f.send('RewardVault', f.rewards, 'finalizeEpoch', [1]);
  await assert.rejects(f.send('RewardVault', f.rewards, 'claim', claimArgs(bad.claims[0])), /InvalidProof/);
});

test('a malformed root with sum exceeding its signed amount cannot overpay its epoch', async () => {
  const f = await fixture();
  f.at(f.genesis + WEEK);
  const m = manifest(f, 0n, [
    { index: '0', recipient: address(6), kind: 0, amount: (10n * UNIT).toString() },
    { index: '1', recipient: address(7), kind: 0, amount: (10n * UNIT).toString() },
  ]);
  const p = await proposal(f, m, { trainingAmount: 10n * UNIT });
  await f.send('RewardVault', f.rewards, 'proposeEpoch', p.args);
  f.advance(CHALLENGE);
  await f.send('RewardVault', f.rewards, 'finalizeEpoch', [0]);
  await f.send('RewardVault', f.rewards, 'claim', claimArgs(m.claims[0]));
  await assert.rejects(f.send('RewardVault', f.rewards, 'claim', claimArgs(m.claims[1])), /BudgetExceeded/);
  assert.equal(await f.read('RewardVault', f.rewards, 'isClaimed', [0, 1]), false);
});

test('emergency pause requires a validator and never freezes ordinary token transfers', async () => {
  const f = await fixture();
  f.at(f.genesis + WEEK);
  const m = manifest(f);
  await propose(f, m);
  f.advance(CHALLENGE);
  await f.send('RewardVault', f.rewards, 'finalizeEpoch', [0]);
  await f.send('RewardVault', f.rewards, 'claim', claimArgs(m.claims[0]));
  await assert.rejects(f.send('RewardVault', f.rewards, 'pause', [], wallets[8]), /Unauthorized/);
  await f.send('RewardVault', f.rewards, 'pause', [], validators[2]);
  await assert.rejects(f.send('RewardVault', f.rewards, 'claim', claimArgs(m.claims[1])), /EnforcedPause/);
  await f.send('HeyunaToken', f.token, 'transfer', [address(8), UNIT], wallets[6]);
  assert.equal(await f.read('HeyunaToken', f.token, 'balanceOf', [address(8)]), UNIT);
  const value = { nonce: await f.read('RewardVault', f.rewards, 'controlNonce'), deadline: f.now + WEEK };
  const signatures = await signed(f, 'rewards', 'Unpause', value, validators.slice(0, 2));
  await assert.rejects(f.send('RewardVault', f.rewards, 'unpause', [value.deadline, [signatures[0]]]), /InvalidQuorum/);
  await f.send('RewardVault', f.rewards, 'unpause', [value.deadline, signatures]);
  await f.send('RewardVault', f.rewards, 'pause');
  await assert.rejects(f.send('RewardVault', f.rewards, 'unpause', [value.deadline, signatures]), /InvalidQuorum/);
});

test('public fund: quorum, seven-day delay, exact recipient, and execution replay protection', async () => {
  const f = await fixture();
  const p = await fundPayment(f);
  const weak = [...p.args.slice(0, -1), [p.args.at(-1)[0]]];
  await assert.rejects(f.send('PublicFund', f.fund, 'queuePayment', weak), /InvalidQuorum/);
  await f.send('PublicFund', f.fund, 'queuePayment', p.args);
  await assert.rejects(f.send('PublicFund', f.fund, 'queuePayment', p.args), /InvalidQuorum/);
  await assert.rejects(f.send('PublicFund', f.fund, 'executePayment', [p.id]), /TimelockActive/);
  f.advance(WEEK - 1n);
  await assert.rejects(f.send('PublicFund', f.fund, 'executePayment', [p.id]), /TimelockActive/);
  f.advance(1n);
  await f.send('PublicFund', f.fund, 'executePayment', [p.id], wallets[6]);
  assert.equal(await f.read('HeyunaToken', f.token, 'balanceOf', [address(8)]), 25n * UNIT);
  assert.equal(await f.read('PublicFund', f.fund, 'reserved'), 0n);
  await assert.rejects(f.send('PublicFund', f.fund, 'executePayment', [p.id]), /WrongState/);
});

test('public fund prevents overcommitment and quorum cancellation releases only its reserved amount', async () => {
  const f = await fixture();
  const p = await fundPayment(f, { amount: 2_000_000n * UNIT });
  await f.send('PublicFund', f.fund, 'queuePayment', p.args);
  const extra = await fundPayment(f, { amount: 1n });
  await assert.rejects(f.send('PublicFund', f.fund, 'queuePayment', extra.args), /InsufficientUnreservedFunds/);
  const value = { paymentId: p.id, reasonHash: HASH, deadline: f.now + WEEK };
  const signatures = await signed(f, 'fund', 'CancelPayment', value, managers.slice(0, 2));
  await f.send('PublicFund', f.fund, 'cancelPayment', [p.id, HASH, value.deadline, signatures]);
  assert.equal(await f.read('PublicFund', f.fund, 'reserved'), 0n);
  await assert.rejects(f.send('PublicFund', f.fund, 'executePayment', [p.id]), /WrongState/);
  await assert.rejects(f.send('PublicFund', f.fund, 'cancelPayment', [p.id, HASH, value.deadline, signatures]), /WrongState/);
});

test('public fund rejects cross-chain, wrong members and altered payment signatures', async () => {
  const f = await fixture();
  const cross = await fundPayment(f, {}, managers.slice(0, 2), { chainId: 1 });
  await assert.rejects(f.send('PublicFund', f.fund, 'queuePayment', cross.args), /InvalidQuorum/);
  const wrong = await fundPayment(f, {}, validators.slice(0, 2));
  await assert.rejects(f.send('PublicFund', f.fund, 'queuePayment', wrong.args), /InvalidQuorum/);
  const altered = await fundPayment(f);
  altered.args[0] = address(7);
  await assert.rejects(f.send('PublicFund', f.fund, 'queuePayment', altered.args), /InvalidQuorum/);
});

test('manifest generation rejects duplicate indices, float amounts and invalid recipients', () => {
  const base = { chainId: 31337, rewardVault: address(0), epoch: 0, allocations: [{ index: '0', recipient: address(6), kind: 0, amount: '1' }] };
  assert.throws(() => buildManifest({ ...base, allocations: [...base.allocations, ...base.allocations] }), /Duplicate/);
  assert.throws(() => buildManifest({ ...base, allocations: [{ ...base.allocations[0], amount: 1 }] }), /base-unit string/);
  assert.throws(() => buildManifest({ ...base, allocations: [{ ...base.allocations[0], recipient: address(0) }] }), /Invalid recipient/);
  assert.throws(() => buildManifest({ ...base, allocations: [{ ...base.allocations[0], kind: 2 }] }), /Claim kind/);
  assert.throws(() => buildManifest({ ...base, epoch: Number.MAX_SAFE_INTEGER + 1 }), /exact nonnegative integer/);
});

test('committed manifest interoperability vector remains byte-identical', () => {
  const vector = JSON.parse(fs.readFileSync(new URL('../fixtures/manifest-v1.json', import.meta.url), 'utf8'));
  const built = buildManifest({ chainId: vector.manifest.chain_id, rewardVault: vector.manifest.reward_vault,
    epoch: vector.manifest.epoch, allocations: [...vector.manifest.allocations].reverse() });
  assert.equal(built.serialized, vector.serialized);
  assert.equal(built.manifestHash, vector.manifestHash);
  assert.equal(built.root, vector.root);
  assert.deepEqual(built.claims, vector.claims);
});

test('stateful 522-week exhaustion: aggregate reservations never exceed either category or 18m', async () => {
  const f = await fixture();
  const trainingPool = 16_200_000n * UNIT;
  const validationPool = 1_800_000n * UNIT;
  let training = 0n;
  let validation = 0n;
  for (let epoch = 0; epoch < 522; epoch += 1) {
    f.at(f.genesis + BigInt(epoch + 1) * WEEK);
    const cap = await f.read('RewardVault', f.rewards, 'categoryBudgets', [epoch]);
    const train = cap.training < trainingPool - training ? cap.training : trainingPool - training;
    const verify = cap.validation < validationPool - validation ? cap.validation : validationPool - validation;
    const m = manifest(f, BigInt(epoch));
    if (train + verify === 0n) {
      const excess = await proposal(f, m, { trainingAmount: 1n, validationAmount: 0n });
      await assert.rejects(f.send('RewardVault', f.rewards, 'proposeEpoch', excess.args), /BudgetExceeded/);
      continue;
    }
    const p = await proposal(f, m, { trainingAmount: train, validationAmount: verify });
    await f.send('RewardVault', f.rewards, 'proposeEpoch', p.args);
    training += train;
    validation += verify;
    assert.equal(await f.read('RewardVault', f.rewards, 'totalAllocated'), training + validation);
    assert(training + validation <= 18_000_000n * UNIT);
  }
  assert.equal(training, trainingPool);
  assert.equal(validation, validationPool);
  assert.equal(await f.read('HeyunaToken', f.token, 'balanceOf', [f.rewards]), 18_000_000n * UNIT);
});

test('deterministic property run: 128 shuffled claims across bitmap words preserve every balance and replay bit', async () => {
  const f = await fixture();
  let seed = 0x48455955;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const allocations = Array.from({ length: 128 }, (_, i) => ({
    index: String(i * 257), recipient: address(6 + next() % 3), kind: next() % 2,
    amount: String(BigInt(next() % 100000 + 1)),
  }));
  const m = manifest(f, 0n, allocations);
  f.at(f.genesis + WEEK);
  await propose(f, m);
  f.advance(CHALLENGE);
  await f.send('RewardVault', f.rewards, 'finalizeEpoch', [0]);
  const shuffled = [...m.claims];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = next() % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const expected = new Map();
  let claimed = 0n;
  for (const row of shuffled) {
    await f.send('RewardVault', f.rewards, 'claim', claimArgs(row), wallets[8]);
    expected.set(row.recipient, (expected.get(row.recipient) ?? 0n) + BigInt(row.amount));
    claimed += BigInt(row.amount);
    assert.equal(await f.read('RewardVault', f.rewards, 'totalClaimed'), claimed);
    assert.equal(await f.read('RewardVault', f.rewards, 'isClaimed', [0, row.index]), true);
  }
  for (const [recipient, amount] of expected) assert.equal(await f.read('HeyunaToken', f.token, 'balanceOf', [recipient]), amount);
  for (const row of shuffled.filter((_, i) => i % 8 === 0)) await assert.rejects(f.send('RewardVault', f.rewards, 'claim', claimArgs(row)), /AlreadyClaimed/);
  assert.equal(await f.read('HeyunaToken', f.token, 'balanceOf', [f.rewards]), 18_000_000n * UNIT - claimed);
});
