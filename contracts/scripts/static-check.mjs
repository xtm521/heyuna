// SPDX-License-Identifier: Apache-2.0
// Small, fail-closed source/ABI policy checks. This is NOT a replacement for Slither or an external audit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './compile.mjs';

const allowedTokenFunctions = new Set([
  'INITIAL_SUPPLY', 'CONTRIBUTION_ALLOCATION', 'PUBLIC_FUND_ALLOCATION',
  'name', 'symbol', 'decimals', 'totalSupply', 'balanceOf', 'transfer', 'allowance', 'approve', 'transferFrom',
]);
const token = JSON.parse(fs.readFileSync(path.join(root, 'abi/HeyunaToken.json'), 'utf8'));
assert.deepEqual(new Set(token.filter((item) => item.type === 'function').map((item) => item.name)), allowedTokenFunctions);
for (const name of fs.readdirSync(path.join(root, 'src')).filter((name) => name.endsWith('.sol'))) {
  const raw = fs.readFileSync(path.join(root, 'src', name), 'utf8');
  const source = raw.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  assert(!/\b(delegatecall|selfdestruct|suicide)\s*\(/.test(source), `${name}: prohibited execution primitive`);
  assert(!/\btx\.origin\b/.test(source), `${name}: tx.origin authorization is prohibited`);
  assert(raw.startsWith('// SPDX-License-Identifier: Apache-2.0\npragma solidity 0.8.38;'), `${name}: source license/compiler must be pinned`);
}
const tokenSource = fs.readFileSync(path.join(root, 'src/HeyunaToken.sol'), 'utf8');
assert.equal((tokenSource.match(/_mint\(/g) ?? []).length, 2);
assert(!tokenSource.includes('function '), 'Token must not add custom callable functions');
const factory = JSON.parse(fs.readFileSync(path.join(root, 'abi/HeyunaTestnet.json'), 'utf8'));
assert(factory.filter((item) => item.type === 'function').every((item) => item.stateMutability === 'view'), 'Factory must have no mutation entry points');
console.log('Static interface/source policy: fixed token API, constructor-only mint calls, read-only factory, no delegatecall/selfdestruct/tx.origin. Passed.');
