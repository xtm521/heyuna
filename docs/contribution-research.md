# Contribution-verification research: measured result and known failure

Observed on 2026-10-26, using one physical Mac, one operator and the pinned
Qwen3-4B-Instruct-2507 revision
`cdbee75f17c01a7cc42f958dc650907174af0554`. This is a small, reproducible research
baseline. It does not establish independent validators, improved coding ability,
Byzantine-proof training, or a security lead over another network.

## What was actually executed

1. Prepared a new **v2 native-chain task**, bound to EVM chain 297012, its full
   manifest genesis hash, genesis-context domain, deployed reward vault and the
   public test recipient. No legacy receipt was converted into a claim right.
2. Ran real MLX training with frozen shared LoRA A and trainable B: one optimizer
   step, rank 8, sequence length 64, seed 42, reviewed q/v projections in layers
   34–35. All model/config/tokenizer bytes were checked against pinned SHA256.
3. Independently reran that specified computation on the same device. The normal
   result and recomputed result both hash to
   `496f8fc4d0c83b0edca48d5488a5447d5d769bd20f4e1b180a533de58472f7eb`.
4. Evaluated actual adapters on two separately authored heldout texts. The normal
   case loss changed from 3.8719638103 to 3.8668113915. These two texts and one step
   cannot demonstrate general model quality improvement.
5. Trained another actual candidate on a disclosed substituted dataset, then
   compared normal and adversarial adapters using full and sampled comparisons.
6. Sent real, signed Cosmos SDK transactions to the four-process local chain:
   task → result → two local verification reports → epoch proposal → public
   challenge → invited-verifier freeze → two-vote resume → finalization. Seven
   deliberately invalid transactions were committed with rejection codes.

The final fresh run (run 3) also created a separate category-one task targeting the
accepted training receipt. A different local worker independently computed the
same B artifact, then a separate full-reference/heldout run verified it. The
chain accepted an evidence-bound verification work commitment, not a second
training-hash claim. Two positive reports accepted that receipt, and both reward
categories entered the same two-leaf epoch. It finalized at height 209 with
root `0xa96e83cad0a897eecdf10b9eb0e28f4d8054eecb385ddf14e743eab44a0d3edc`.
The final run includes **seven** actual rejected transactions, including a
verification result missing its evidence commitment.

Run 3 used a fresh genesis after correcting an upstream EVM/SDK supply-accounting
boundary. Earlier run 1 and run 2 artifacts remain historical evidence of their
contribution flows; they do not establish the final implementation's supply
consistency. The final full genesis hash is
`0xf79baaec0021985f848c1d1ac7ec3f5a7b5a31ff01d3f44e6b1c450ff6c84774`.
Native claim receipts and all-account supply checks are recorded separately.

The chain profile was **accelerated-local**, EVM 297012 / Cosmos
`heyuna_297012-1`, with its disclosed **3-second** challenge. The separate default
research profile, EVM 297011, keeps a fixed **72-hour** challenge. Its exact
deadline and replay behavior are covered by real SDK multistore tests using
block-header times; no clock-changing RPC was added.

## Pre-registered comparison and result

The experiment writes its task, heldout/data hashes, attack-generation rules,
numerical tolerance, coordinate count, seed and promotion gates before running
the comparison. This is a locally recorded policy, with no independent timestamp
registration claim. Current pre-registration policy hash:
`fc717cd4df6fb7640ecfc069bdb2abc3273ee10a145d76f7158d98e5fdfd0a4d`.

The full baseline checks every adapter coordinate against the real recomputed
reference (`atol=1e-5`, `rtol=1e-2`), performs a separate heldout non-regression
check with a 1% tolerance, and applies domain/deduplication eligibility checks.
The experimental sampler checks 512 coordinates against that same reference.
The reference computation is charged to **both** methods; it is not a free
oracle. The sampler's public reproducibility seed is not an unpredictable
production challenge.

| Case | Full computation agrees | Other relevant check | Full baseline | Sampler |
|---|---|---|---|---|
| Normal real training | Yes | Heldout within tolerance | Accept | Accept |
| Skip all assigned steps; return base B | No | Format/norm alone pass | Reject | Reject |
| Old task/domain receipt with identical correct bytes | Yes | Domain binding fails | Reject | Reject |
| Byte-identical result already rewarded | Yes | Duplicate eligibility fails | Reject | Reject |
| Real training on substituted data | No | Tiny heldout alone still passes | Reject | Reject |
| One finite, norm-bounded corrupted coordinate | No | Tiny heldout still passes | Reject | **Accept** |
| Same corruption with two dishonest approval keys | No | A 2/3 threshold can authorize dishonest work | Reject with honest recomputation | **Accept** |

The last row's threshold outcome is a policy model of the documented trust
boundary. It is not a separately operated live collusion attack. The sparse
corruption changes one B coordinate by 0.1; it does not claim to install a
semantic backdoor. The stale/copy checks model their declared eligibility
conditions; actual chain duplicate and domain enforcement are separate SDK
tests and transaction evidence.

| Measured verification component | Seconds |
|---|---:|
| Actual full-reference recomputation | 4.3146 |
| Actual heldout evaluation of the test adapters | 3.7796 |
| Baseline reference + heldout + full comparisons | 8.0949 |
| Sampler reference + heldout + sampled comparisons | 8.1082 |

The sampler was about **0.164% slower**, while accepting 2 of 6 designed attack
cases. It failed the detection gate and the required **30%** time-reduction gate.
One normal sample and six correlated attacks also fail the pre-registered
independent-sample minimum. **The sampler is not promoted; full recomputation and
separate heldout evaluation remain the baseline.** These are measured research
costs in this run, not general device-performance estimates.

Wilson 95% descriptive intervals are included in the machine-readable report:
baseline attack acceptance 0/6: [0, 0.3903]; sampler 2/6: [0.0968, 0.7000]; normal
false rejection 0/1: [0, 0.7935]. The trials are intentionally correlated and
tiny, so these intervals do not establish population security rates.

## Reproduce

Use the repository's locked Python environment with the Mac MLX extra (or a
separately validated CUDA environment), and prepare the pinned unquantized model
using the existing explicit model-preparation flow. Model weights are not in
the repository. First create/deploy the local accelerated network using the
root README, preserving its new genesis and public deployment manifest.

```sh
export PYTHONPATH=backend HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
python scripts/prepare_contribution_research.py \
  --deployment .state/chain-accelerated/deployment.json \
  --recipient 0xPUBLIC_TEST_RECIPIENT \
  --output .state/contribution-research/native-job
python -m heyuna.training --job-dir .state/contribution-research/native-job \
  --model-path /prepared/pinned-model --backend mlx
python -m heyuna.training --job-dir .state/contribution-research/native-job \
  --model-path /prepared/pinned-model --backend mlx \
  --candidate .state/contribution-research/native-job/result.safetensors \
  --heldout .state/contribution-research/native-job/heldout.json
python scripts/contribution_experiment.py \
  --job-dir .state/contribution-research/native-job \
  --model-path /prepared/pinned-model --backend mlx \
  --output .state/contribution-research/experiment.json
python scripts/contribution_chain_smoke.py \
  --job-dir .state/contribution-research/native-job \
  --model-path /prepared/pinned-model --backend mlx
```

For the chain smoke, use the fresh accelerated network's public **faucet**
recipient from `public-accounts.json`. The script deliberately supports only
its disposable loopback 3-second profile, uses local test keyrings, and requires
successful new v2 full-recomputation evidence before sending transactions. Run
it once per fresh genesis; the resulting finalized epoch cannot be overwritten.
The final smoke independently reruns the actual model for a category-one task
bound to the training receipt, commits a separate evidence-bound work hash, and
allocates 1 tHEYUNA for training plus 0.1 tHEYUNA for independent recomputation
in a two-leaf epoch. The latter recipient is a different public test account;
all local keys still belong to one operator. These are not mainnet entitlements.
A separate external
wallet action submits the claim; this script cannot access that wallet.

Unit/SDK checks:

```sh
python -m pytest tests/test_research.py
sh scripts/chain_go.sh test ./x/contribution/... ./precompiles/contribution/...
```

The Go suite includes actual mounted SDK stores, protobuf signer extraction,
72-hour and 3-second boundaries, nonce replays, category/cumulative budgets,
restored-state invariants, readonly SDK gas/revert handling and OpenZeppelin
Merkle interoperability for 1/2/3/4/5/128 leaves.

## Evidence and limits

- [Real-model experiment JSON](evidence/contribution-research.json)
- [Real local SDK contribution transactions](evidence/native-contribution.json)
- [Earlier single-category run](evidence/native-contribution-run1.json) and
  [earlier research timings](evidence/contribution-research-run1.json), preserved
  under their original genesis and protocol snapshot
- [Earlier two-category run](evidence/native-contribution-run2.json) and
  [run 2 research timings](evidence/contribution-research-run2.json), preserved
  before the supply-accounting correction and final fresh genesis
- [On-chain contribution protocol and settlement ABI](../chain/x/contribution/README.md)

Both public JSON reports passed Gitleaks 8.30.1 and explicit private-marker scans
before copying. Private keyrings, mnemonics, model weights and private filesystem
paths are excluded. Full recomputation demonstrates numerical agreement within
tolerance; it does not establish who performed the work. Two colluding invited
verifiers can approve dishonest reports, and tiny heldout tests can miss harmful
updates. Independent operators, adversarial quality benchmarks, multi-device
numeric validation and lower-cost cryptographic proofs remain open work.

The final source also closes three reviewed protocol weaknesses: unapproved raw
hashes cannot occupy a global reward slot; changing target-receipt aliases cannot
give the same worker a second reward for the same original artifact; and two
verifiers can cancel a malicious first vote and re-propose within the current
week. These have regression and independent overlay checks. A permanently
malicious invited verifier can still repeatedly use its emergency freeze power;
that liveness limitation remains explicit.
