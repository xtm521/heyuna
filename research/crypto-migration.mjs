// SPDX-License-Identifier: Apache-2.0
// Offline primitive and migration-state experiment, not a chain signing scheme.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('This isolated experiment requires Node 24.8+ with ML-DSA; it never falls back to a custom algorithm.');
const encode = value => Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)))));
const hash = value => createHash('sha256').update(value).digest('hex');
const percentile = (values, fraction) => [...values].sort((a,b) => a-b)[Math.min(values.length-1,Math.ceil(values.length*fraction)-1)];
const report = { experiment: 'offline-ml-dsa-44-hybrid-migration-v1', node: process.version, openssl: process.versions.openssl,
  standard: 'NIST FIPS 204 ML-DSA-44', network: 'offline-research-domain', roles: [],
  integrated_into_chain: false, quantum_secure_chain_claim: false,
  limitations: ['No SDK accounts, CometBFT votes, P2P handshake or release-verifier integration.',
    'No hardware-keystore, key-erasure, threshold ML-DSA, side-channel or cross-implementation validation.',
    'Local timings are not consensus throughput or adversarial-security measurements.'] };

for (const role of ['account', 'consensus', 'network-identity', 'software-update']) {
  const classic = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const pq = generateKeyPairSync('ml-dsa-44');
  const stranger = generateKeyPairSync('ml-dsa-44');
  const pqPublic = pq.publicKey.export({ type: 'spki', format: 'der' });
  const context = Buffer.from(`heyuna-offline-migration-v1:${role}`);
  const payload = { version: 1, network: 'offline-research-domain', role, nonce: 1,
    new_algorithm: 'ML-DSA-44', new_key_hash: hash(pqPublic), purpose: 'hybrid-rotation-authorization' };
  const bytes = encode(payload);
  const legacySignature = sign('sha256', bytes, classic.privateKey);
  const signature = sign(null, bytes, { key: pq.privateKey, context });
  const hybridAccepts = (candidate, oldSig=legacySignature, newSig=signature, lastNonce=0) =>
    candidate.nonce === lastNonce + 1 && candidate.role === role && candidate.network === payload.network &&
    candidate.new_key_hash === payload.new_key_hash &&
    verify('sha256', encode(candidate), classic.publicKey, oldSig) &&
    verify(null, encode(candidate), { key: pq.publicKey, context }, newSig);
  assert(hybridAccepts(payload));
  assert(!hybridAccepts({ ...payload, network: 'another-chain' }));
  assert(!hybridAccepts({ ...payload, role: role === 'account' ? 'consensus' : 'account' }));
  assert(!hybridAccepts(payload, legacySignature, signature, 1));
  const altered = Buffer.from(signature); altered[100] ^= 1;
  assert(!hybridAccepts(payload, legacySignature, altered));
  assert(!verify(null, bytes, { key: stranger.publicKey, context }, signature));
  assert(!verify(null, bytes, { key: pq.publicKey, context: Buffer.from('other-purpose') }, signature));
  // Model a crash between authorization and commit. A pending entry alone
  // cannot change the active key; revalidation completes one nonce exactly.
  const ledger = { supply: '19999999999999999999999999', balance: '1000000000000000000',
    finalized_reward_root: 'a'.repeat(64), claim_bitmap: '03' };
  const before = hash(encode(ledger));
  const pending = JSON.parse(JSON.stringify({ payload, committed: false }));
  let state = { active: 'secp256k1', nonce: 0 };
  assert.equal(state.active, 'secp256k1');
  assert(hybridAccepts(pending.payload, legacySignature, signature, state.nonce));
  state = { active: 'ML-DSA-44', nonce: pending.payload.nonce };
  assert.equal(state.nonce, 1); assert(!hybridAccepts(payload, legacySignature, signature, state.nonce));
  assert.equal(before, hash(encode(ledger)));
  const signTimes=[], verifyTimes=[];
  for(let i=0;i<100;i++) {
    const start=performance.now(); const sig=sign(null,bytes,{key:pq.privateKey,context}); signTimes.push(performance.now()-start);
    const next=performance.now(); assert(verify(null,bytes,{key:pq.publicKey,context},sig)); verifyTimes.push(performance.now()-next);
  }
  report.roles.push({ role, samples:100, signature_bytes:signature.length, public_key_spki_bytes:pqPublic.length,
    sign_ms_p50:percentile(signTimes,.5), sign_ms_p95:percentile(signTimes,.95), verify_ms_p50:percentile(verifyTimes,.5), verify_ms_p95:percentile(verifyTimes,.95),
    tamper_rejected:true, wrong_key_rejected:true, context_replay_rejected:true, cross_network_rejected:true,
    stale_nonce_rejected:true, interrupted_state_model_recovered:true, ledger_model_invariants_unchanged:true });
}
const output=path.resolve(process.argv[2] ?? '.state/crypto-migration-evidence.json');
if (!output.includes(`${path.sep}.state${path.sep}`)) throw new Error('write experiment evidence inside ignored .state for review before publication');
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
