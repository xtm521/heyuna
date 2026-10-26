# Contribution protocol v1

This is a Cosmos SDK module with its own committed KV store, protobuf transaction
service, authenticated Cosmos signer, CLI and fixed-size EVM read-only precompile.
It never executes training or floating-point evaluation inside a block, and it
has no mint, burn, bank transfer or arbitrary message execution dependency.

## Network domains

The normal research profile is `heyuna_297011-1` / EVM `297011`, with a fixed
259,200-second (72-hour) challenge. An explicitly unsafe accelerated local profile
is restricted to `heyuna_297012-1` / EVM `297012`, with a 3-second challenge.
Changing the period without changing into that separate domain is rejected at
genesis. Neither profile has a clock-changing RPC or transaction operation.

Genesis config includes `version`, `chain_id`, `evm_chain_id`, `network_domain`,
`vault_address`, three distinct `verifiers`, `start_time` (Unix seconds),
`challenge_period_seconds` and `unsafe_test_profile`. `network_domain` commits to
the genesis context. The separately distributed network manifest pins the full
genesis file hash; putting a genesis file's own hash inside itself is circular.

Every operation is a protobuf `/heyuna.contribution.v1.MsgExecute` with a signer
annotated `sender` and `payload` containing the following JSON envelope:

```json
{
  "version": 1,
  "chain_id": "heyuna_297011-1",
  "network_domain": "0x<32-byte-genesis-context-commitment>",
  "vault_address": "0x<20-byte-reward-vault>",
  "kind": "submit_task",
  "body": {}
}
```

The payload is at most 48 KiB. Unknown operation/body fields and trailing JSON
values are rejected. The authenticated Cosmos sender is converted to its 20-byte
EVM account identity. The SDK chain ID, network domain and vault must match the
immutable genesis configuration on every operation.

## Operations

| Kind | Body | Authorization / result |
|---|---|---|
| `submit_task` | `model_hash`, `data_hash`, `template_hash`, `config_hash` (bytes32); `round`, `nonce` (uint64); `recipient`; `category`; category 1 also requires `verification_target` | Any account; task ID is recomputed from the complete domain and task, including submitter. |
| `submit_result` | Training: `task_id`, `result_hash`. Verification: `task_id`, `verification_target`, `artifact_hash`, `evidence_hash` | Task submitter; one result per task. Raw training hashes become globally reserved only after a reward quorum. |
| `submit_report` | `receipt_id`, `report_hash`, `accept` | Invited verifier, excluding the task submitter and recipient; one immutable report per verifier. |
| `propose_epoch` | `epoch`, `nonce`, `entries` | Two distinct invited verifiers submit the identical proposal. Each entry requires two positive reports. |
| `challenge` | `epoch`, `evidence_hash` | Any authenticated account; registration records evidence without freezing the epoch. |
| `freeze_epoch` | `epoch`, `nonce` | One invited verifier; pending → frozen. |
| `resume_epoch` / `cancel_epoch` | `epoch`, `nonce` | Two distinct invited verifiers vote for the same action. Each may vote once per nonce. Resume restarts the complete challenge period. Two may cancel a one-vote proposal without touching unreserved budgets. |
| `finalize_epoch` | `epoch` | Any account, after the complete challenge deadline; pending → finalized. |

`entries` contains at most 128 entries. Each entry is `{index, receipt_id,
category, amount, recipient}`. Indices are contiguous `0..n-1` across the epoch,
not separately per category. `amount` is a positive canonical decimal uint256.
The receipt category and recipient must match the immutable task. The module
calculates the Merkle root and exact category totals; verifiers cannot supply an
unchecked root or silently allocate a receipt twice.

Category-one work must reference a category-zero receipt already accepted by two
invited verifiers. Model/data/template/config/round must exactly match that
target's computation. Worker and recipient must differ from the original
training submitter and recipient. One worker can create one verification work
item per original raw artifact hash; changing target receipt IDs or task nonces
cannot create another reward for identical work. Different workers may perform
separately accepted recomputation, subject to the verification budget.

The recomputed B artifact must equal the target's raw result hash. The independent
work `result_hash` is **calculated by the keeper**, not supplied by a caller:
`0x + SHA256(canonical JSON)` of
`{version:1, domain, chain_id, evm_chain_id, vault, task_id, worker,
verification_target, artifact_hash, evidence_hash}`. Object keys are sorted,
encoding is compact UTF-8, integers use decimal JSON numbers, and hex strings
are lowercase. `chain_id` is the Cosmos string; `evm_chain_id` is its numeric EVM
identity. `evidence_hash` commits to a versioned recomputation evidence object
binding the v2 task, coordinator receipt namespace, chain target receipt,
original artifact and actual recomputation metrics. Its bytes and evaluation
truth still require honest invited verifiers. The receipt ID additionally binds
the task ID and this result commitment.

Unapproved raw training hashes cannot permanently occupy a global index. At
the second matching epoch vote, duplicate raw hashes are rejected within the
batch and against previous pending/frozen/finalized reservations. Cancellation
releases its own reservations; finalization keeps them permanently. A legacy
`result/H` index is honored only when its referenced receipt is allocated, so
already finalized local history remains valid without granting a pending
observer a denial-of-service lock.

The first proposal uses nonce 0. Initial voting does not reserve funds. The
second matching vote reserves exact amounts, locks receipts, increments the
control nonce and starts the challenge period. Freeze increments the nonce;
resume/cancel quorum increments it again. A first voter cannot lock the week:
two other verifiers may cancel its voting proposal without releasing any
unreserved receipt or budget. A cancelled epoch can be reproposed
only in its current week using its fresh nonce. Finalized records cannot be
replaced, frozen, cancelled, resumed or finalized a second time.

Unlike the historical Sepolia Alpha schedule, v1 proposals use the **current**
release week: `epoch == floor((blockTime - startTime) / 604800)`. Epoch 0 may be
proposed during the initial week once work is accepted. Past gaps cannot be
backfilled and future weeks cannot be allocated early. Finalization may cross a
week boundary. The first 520 weekly caps use integer differences of 14 million
18-decimal units, split 90% / 10%; subsequent weeks keep the original single-week
cap. Unused funds remain in the vault. Cumulative category reservations, including
finalized epochs, are capped at 12.6 million and 1.4 million units. Cancellation
releases that proposal's reservations. Nothing in this module mints currency.

## EVM settlement ABI

The original address `0x0000000000000000000000000000000000000900` does not overlap
Cosmos EVM v0.7.3's upstream precompiles. The app enables only this custom static
precompile; its implementation contains no write operation.

```solidity
function getEpoch(uint256 epoch) external view returns (
  bytes32 root, uint256 trainingBudget,
  uint256 verificationBudget, bool finalized
);
function getNetwork() external view returns (
  uint256 chainId, bytes32 networkDomain, address vault,
  uint256 challengeSeconds, bool accelerated
);
```

Unknown epochs return zero root, zero totals and `false`. Pending/frozen/cancelled
roots remain visible with `finalized=false`; settlement must require `true`.
Calldata must be exactly 4 or 36 bytes for the declared method, with no value.
Epoch arguments above uint64 are rejected. Output is bounded to 160 bytes.
SDK reads are metered through the upstream precompile cache/snapshot/gas wrapper;
minimum EVM gas is `5000 + 12*min(inputLength,4096)`. Both ordinary calls and
STATICCALL execute the same view-only code.

Reward leaf:

```solidity
keccak256(bytes.concat(keccak256(abi.encode(
  uint256(chainId), address(vault), uint256(epoch), uint8(category),
  uint256(index), address(recipient), uint256(amount), bytes32(receiptId)
))))
```

Merkle construction exactly matches OpenZeppelin StandardMerkleTree 1.0.8:
sort double-hashed leaves, place them in reverse order at the bottom of a complete
binary heap, and hash lexicographically sorted children up to the root. Claim
bitmap indices are global per epoch. JavaScript/Go interoperability vectors cover
3, 5 and 128 leaves, including every OpenZeppelin proof. The native vault
independently rejects repeat claims, excessive category/cumulative payments and
chain/contract replay.

## CLI

```sh
heyunad tx contribution execute payload.json --from worker --chain-id heyuna_297011-1
heyunad query contribution config
heyunad query contribution task 0xTASK_ID
heyunad query contribution receipt 0xRECEIPT_ID
heyunad query contribution epoch 0
heyunad query contribution challenge 0xCHALLENGE_ID
heyunad query contribution accounting
```

Successful transactions emit `heyuna.contribution` with `operation` and `id`.
The IDs are task/receipt/challenge commitments or the decimal epoch number.
RPC transport alone is not a confirmed receipt: clients must check committed
transaction success and query the resulting record at the correct chain.

## Trust and verification limits

SDK signatures authenticate operators. Hashes bind exact public commitments.
The Merkle tree proves inclusion in a finalized allocation. None alone proves
that an operator performed training or improved a model. Two colluding invited
verifiers can approve dishonest work. Public challenges need an honest invited
verifier to freeze a pending batch, and two to resolve it. One permanently
malicious invited verifier can still repeatedly freeze pending work; the first
research release does not claim Byzantine liveness for this emergency power.
Challenges are not
automatically adjudicated by the chain. This first implementation keeps full
recomputation and independent quality evaluation off chain as the baseline.

Current tests use a real mounted SDK multistore and generated protobuf signer
descriptors, including the full 72-hour header-time deadline, nonce replays,
quorum, category and cumulative budgets, restored state, duplicate results,
self-verification and precompile bounds. They do not establish independent
operators, production cryptoeconomic security or a full formal proof.
