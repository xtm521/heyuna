// SPDX-License-Identifier: Apache-2.0
// Run from the repository root using its pinned Node/dependency environment.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nativeBundle } from '../../../../contracts/scripts/native-protocol.mjs';

const vectors = [1, 2, 3, 4, 5, 128].map(size => {
  const allocations = Array.from({ length: size }, (_, index) => ({
    index, recipient: `0x${(256 + index).toString(16).padStart(40, '0')}`,
    category: index % 2, amount: String(1000 + index),
    contribution_id: `0x${createHash('sha256').update(`heyuna-interop-${index}`).digest('hex')}`,
  }));
  const chainId = 297012, epoch = 7, vault = '0x0000000000000000000000000000000000001000';
  const bundle = nativeBundle({ chainId, epoch, rewardVault: vault,
    genesisHash: `0x${'01'.repeat(32)}`, allocations });
  return { size, chain_id: chainId, epoch, vault, root: bundle.root,
    entries: allocations.map(a => ({ index: a.index, recipient: a.recipient,
      category: a.category, amount: a.amount, receipt_id: a.contribution_id })),
    claims: bundle.claims };
});
writeFileSync(fileURLToPath(new URL('./native-merkle-vectors.json', import.meta.url)), `${JSON.stringify({
  source: '@openzeppelin/merkle-tree 1.0.8 through contracts/scripts/native-protocol.mjs nativeBundle',
  vectors,
}, null, 2)}\n`);
