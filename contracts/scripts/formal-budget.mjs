// SPDX-License-Identifier: Apache-2.0
// Symbolic arithmetic model only. These proofs do NOT establish bytecode refinement, signature security,
// validator independence, honest task evaluation, or security of the Ethereum network.
import assert from 'node:assert/strict';
import { init, killThreads } from 'z3-solver';

// Emscripten's environment serializer requires an ASCII executable label even in Unicode workspaces.
const api = await init({ thisProgram: 'heyuna-formal-budget' });
const { Int, Solver, Or } = new api.Context('HeyunaBudget');
const POOL = 18_000_000n * 10n ** 18n;
const TRAIN = POOL * 9n / 10n;
const VALIDATE = POOL - TRAIN;
const UINT_MAX = (1n << 256n) - 1n;
let proven = 0;
async function prove(name, assumptions, violation) {
  const solver = new Solver();
  solver.set('timeout', 10_000);
  solver.add(...assumptions, violation);
  const result = await solver.check();
  assert.equal(result, 'unsat', `${name}: counterexample or timeout (${result})`);
  proven += 1;
  console.log(`UNSAT counterexample: ${name}`);
}
try {
  const epoch = Int.const('epoch');
  const before = Int.val(POOL).mul(epoch).div(520);
  const after = Int.val(POOL).mul(epoch.add(1)).div(520);
  const delta = after.sub(before);
  await prove('Every planned integer-difference weekly budget is between floor and ceil',
    [epoch.ge(0), epoch.lt(520)], Or(delta.lt(POOL / 520n), delta.gt((POOL + 519n) / 520n)));
  await prove('Weekly delta preserves the exact cumulative schedule',
    [epoch.ge(0), epoch.lt(520)], before.add(delta).neq(after));

  const allocatedT = Int.const('allocatedTraining');
  const allocatedV = Int.const('allocatedValidation');
  const amountT = Int.const('proposedTraining');
  const amountV = Int.const('proposedValidation');
  const guards = [allocatedT.ge(0), allocatedV.ge(0), amountT.ge(0), amountV.ge(0),
    allocatedT.add(amountT).le(TRAIN), allocatedV.add(amountV).le(VALIDATE)];
  await prove('Accepted reservations preserve total <= 18m and neither category can overflow uint256', guards,
    Or(allocatedT.add(amountT).add(allocatedV).add(amountV).gt(POOL), allocatedT.add(amountT).gt(UINT_MAX), allocatedV.add(amountV).gt(UINT_MAX)));

  const claim = Int.const('claim');
  const claimed = Int.const('claimed');
  const allocated = Int.const('allocated');
  await prove('Accepted claims preserve 0 <= claimed <= allocated <= pool',
    [claim.gt(0), claimed.ge(0), allocated.ge(0), allocated.le(POOL), claimed.add(claim).le(allocated)],
    Or(claimed.add(claim).lt(0), claimed.add(claim).gt(POOL), claimed.add(claim).gt(UINT_MAX)));

  const balance = Int.const('balance');
  const reserved = Int.const('reserved');
  const payment = Int.const('payment');
  await prove('A queued treasury payment preserves balance >= reserved',
    [balance.ge(0), balance.le(2_000_000n * 10n ** 18n), reserved.ge(0), reserved.le(balance), payment.gt(0), payment.le(balance.sub(reserved))],
    reserved.add(payment).gt(balance));
  await prove('Executing one reserved treasury payment preserves balance >= remaining reservations',
    [balance.ge(reserved), reserved.ge(payment), payment.gt(0)],
    Or(balance.sub(payment).lt(0), reserved.sub(payment).lt(0), balance.sub(payment).lt(reserved.sub(payment))));
  console.log(`${proven} symbolic arithmetic obligations proven. Full smart-contract verification remains an independent audit gate.`);
} finally {
  await killThreads(api.em);
}
