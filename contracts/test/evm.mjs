// SPDX-License-Identifier: Apache-2.0
// Entirely in-memory EVM. Keys 1..9 below are PUBLIC, INSECURE TEST FIXTURES, never wallet setup.
import assert from 'node:assert/strict';
import { createBlock } from '@ethereumjs/block';
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { createLegacyTx } from '@ethereumjs/tx';
import { createAccount, createAddressFromString, createAddressFromPrivateKey, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { createVM, runTx } from '@ethereumjs/vm';
import { Interface, Wallet, getAddress, TypedDataEncoder } from 'ethers';
import { compile } from '../scripts/compile.mjs';
import { TYPES, domain, buildManifest } from '../scripts/protocol.mjs';

export const artifacts = compile();
export const interfaces = Object.fromEntries(Object.entries(artifacts).map(([name, artifact]) => [name, new Interface(artifact.abi)]));
export const WEEK = 604800n;
export const CHALLENGE = 259200n;
export const UNIT = 10n ** 18n;
export const wallets = Array.from({ length: 9 }, (_, index) => new Wallet(`0x${BigInt(index + 1).toString(16).padStart(64, '0')}`));
export const validators = wallets.slice(0, 3);
export const managers = wallets.slice(3, 6);
export const address = (index) => wallets[index].address;
export const HASH = `0x${'ab'.repeat(32)}`;

export async function makeChain(chainId = 31337) {
  const common = createCustomCommon({ chainId }, Mainnet, { hardfork: Hardfork.Cancun });
  const vm = await createVM({ common });
  let now = 1900000000n;
  let number = 1n;
  for (const wallet of wallets) {
    await vm.stateManager.putAccount(createAddressFromString(wallet.address), createAccount({ nonce: 0n, balance: 10n ** 30n }));
  }
  const block = () => createBlock({ header: { number, timestamp: now, gasLimit: 40_000_000n, baseFeePerGas: 1n } }, { common });
  function failure(result, label) {
    if (!result.execResult.exceptionError) return;
    const data = bytesToHex(result.execResult.returnValue);
    let message = `${label}: ${result.execResult.exceptionError.error}`;
    for (const abi of Object.values(interfaces)) {
      try { const decoded = abi.parseError(data); if (decoded) { message += ` ${decoded.name}`; break; } } catch {}
    }
    throw new Error(`${message} (${data})`);
  }
  async function transact(to, data, signer = wallets[0]) {
    const key = hexToBytes(signer.privateKey);
    const sender = createAddressFromPrivateKey(key);
    const account = await vm.stateManager.getAccount(sender);
    const tx = createLegacyTx({
      to: to ? createAddressFromString(to) : undefined, nonce: account.nonce, gasLimit: 30_000_000n,
      gasPrice: 2n, data: hexToBytes(data), value: 0n,
    }, { common }).sign(key);
    const result = await runTx(vm, { tx, block: block() });
    number += 1n;
    failure(result, 'transaction');
    return result;
  }
  async function deploy(name, args = []) {
    const abi = interfaces[name];
    const data = `0x${artifacts[name].evm.bytecode.object}${abi.encodeDeploy(args).slice(2)}`;
    const result = await transact(undefined, data);
    return getAddress(result.createdAddress.toString());
  }
  async function send(name, to, method, args = [], signer) {
    return transact(to, interfaces[name].encodeFunctionData(method, args), signer);
  }
  async function read(name, to, method, args = []) {
    await vm.stateManager.checkpoint();
    let result;
    try {
      result = await vm.evm.runCall({
        to: createAddressFromString(to), caller: createAddressFromString(wallets[0].address),
        data: hexToBytes(interfaces[name].encodeFunctionData(method, args)), isStatic: true,
        gasLimit: 30_000_000n, block: block(),
      });
    } finally { await vm.stateManager.revert(); }
    failure(result, 'read');
    const decoded = interfaces[name].decodeFunctionResult(method, bytesToHex(result.execResult.returnValue));
    return decoded.length === 1 ? decoded[0] : decoded;
  }
  return {
    vm, chainId, deploy, send, read,
    get now() { return now; },
    advance(seconds) { now += BigInt(seconds); },
    at(timestamp) { assert(BigInt(timestamp) >= now, 'time cannot go backwards'); now = BigInt(timestamp); },
  };
}

export async function fixture() {
  const chain = await makeChain();
  const genesis = chain.now + 60n;
  const factory = await chain.deploy('HeyunaTestnet', [validators.map((w) => w.address), managers.map((w) => w.address), genesis]);
  const token = await chain.read('HeyunaTestnet', factory, 'token');
  const rewards = await chain.read('HeyunaTestnet', factory, 'rewards');
  const fund = await chain.read('HeyunaTestnet', factory, 'publicFund');
  return { ...chain, get now() { return chain.now; }, factory, token, rewards, fund, genesis };
}

export async function signed(f, kind, type, value, signers, overrides = {}) {
  const typedDomain = { ...domain(kind, kind === 'rewards' ? f.rewards : f.fund, f.chainId), ...overrides };
  const signaturePairs = await Promise.all(signers.map(async (wallet) => ({ address: wallet.address.toLowerCase(), signature: await wallet.signTypedData(typedDomain, { [type]: TYPES[type] }, value) })));
  signaturePairs.sort((a, b) => a.address.localeCompare(b.address));
  return signaturePairs.map((pair) => pair.signature);
}

export function manifest(f, epoch = 0n, allocations = [
  { index: '0', recipient: address(6), kind: 0, amount: (100n * UNIT).toString() },
  { index: '1', recipient: address(7), kind: 1, amount: (10n * UNIT).toString() },
]) {
  return buildManifest({ chainId: f.chainId, rewardVault: f.rewards, epoch, allocations });
}

export async function proposal(f, m, overrides = {}, signers = validators.slice(0, 2), signingOverrides = {}) {
  const epoch = BigInt(m.manifest.epoch);
  const stored = await f.read('RewardVault', f.rewards, 'epochs', [epoch]);
  const value = {
    epoch, root: m.root, manifestHash: m.manifestHash, trainingAmount: m.trainingAmount,
    validationAmount: m.validationAmount, nonce: stored.nonce, deadline: f.now + WEEK, ...overrides,
  };
  const signatures = await signed(f, 'rewards', 'RewardProposal', value, signers, signingOverrides);
  const args = [value.epoch, value.root, value.manifestHash, value.trainingAmount, value.validationAmount, value.deadline, signatures];
  return { value, signatures, args };
}

export async function propose(f, m = manifest(f)) {
  const p = await proposal(f, m);
  await f.send('RewardVault', f.rewards, 'proposeEpoch', p.args);
  return p;
}

export function claimArgs(claim) {
  return [claim.epoch, claim.index, claim.recipient, claim.kind, claim.amount, claim.proof];
}

export async function fundPayment(f, overrides = {}, signers = managers.slice(0, 2), signingOverrides = {}) {
  const value = {
    recipient: address(8), amount: 25n * UNIT, descriptionHash: HASH,
    nonce: await f.read('PublicFund', f.fund, 'nextNonce'), deadline: f.now + WEEK, ...overrides,
  };
  const signatures = await signed(f, 'fund', 'FundPayment', value, signers, signingOverrides);
  const id = TypedDataEncoder.hash(domain('fund', f.fund, f.chainId), { FundPayment: TYPES.FundPayment }, value);
  return { value, id, args: [value.recipient, value.amount, value.descriptionHash, value.deadline, signatures] };
}
