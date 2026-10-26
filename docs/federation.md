> Current native v2 settlement is described in [protocol-v2](protocol-v2.md) and [research operations](researchnet-operations.md). This file preserves training-runtime details and explicitly legacy Alpha coordinator examples.

# Heyuna invited federation alpha

This implementation contains real MLX/CUDA training entrypoints and an authenticated task/receipt
coordinator. Local protocol tests are not evidence of multi-device training, improved coding quality,
independent validator operators, public network deployment or chain payment.

## Reviewed training cohort

- Official model: `Qwen/Qwen3-4B-Instruct-2507`, revision
  `cdbee75f17c01a7cc42f958dc650907174af0554`; same tokenizer revision, unquantized BF16 base.
- Alpha template: `heyuna-ffa-causal-lm-v1`, last two transformer blocks (34/35), q/v projections only.
  Rank 8, scale 1, dropout 0, batch size 1, bounded sequence length and steps, AdamW, gradient norm 1.
  All ten model/config/tokenizer files are verified offline against pinned SHA256 values before loading.
  The hashes were cross-checked against official commit metadata, not merely a locally asserted revision.
- The coordinator distributes actual float32 shared-A safetensors, not merely an RNG seed.
  A is frozen. Only B trains. Base-B hash also binds the starting cohort.
- Canonical/PEFT A is `(8, input)` and B is `(output, 8)`; MLX A is `(input, 8)` and B is `(8, output)`.
  Both A and B transpose on MLX conversion. PEFT alpha is 8, hence alpha/rank = 1.
- Result artifacts are safetensors only, capped at 4 MiB. No pickle, remote Python, optimizer programs,
  task-supplied commands or arbitrary URLs. Exact keys/shapes, float32, finite values, frozen-A hash,
  baseline hash and a whole-update L2 bound of 25 are checked before acceptance.
- Aggregation averages B using coordinator-assigned work units only after two validator acceptances.
  Shared model/revision/config/A/base-B/round must match. The aggregate is a candidate requiring its own
  held-out evaluation before assignment to another round. Aggregation is not automatic model promotion.

The implementation follows the [MLX LoRA source](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/tuner/lora.py)
and [PEFT LoRA documentation](https://huggingface.co/docs/peft/main/en/package_reference/lora).

## Local node and operational limits

`NetworkService(state_dir, resource_lock)` mounts `/network/status`, `/network/configure`,
`/network/contribution`, `/network/run-once`, `/network/receipts`; the root application adds `/api`
and local bearer authentication. On POSIX platforms, configuration is stored with mode 0600;
credentials are never echoed to the UI. Windows `chmod` and `stat` permission bits do not establish
equivalent access control. Windows credential isolation depends on the directory/file ACLs and still
requires real-device verification; the current tests do not prove Windows credential privacy.
Contribution is disabled on every app start. Configure does not authenticate or connect.

Run once authenticates, claims a 15-minute renewable lease, verifies all artifacts, then starts the
fixed training module in a child process. The child receives no coordinator or wallet tokens in its
environment. It uses an already prepared local model; downloading models requires the separate
explicit preparation action. The model resource lock is held by the worker thread throughout training.

Settings are enforced at start and while training: permitted local time window, process RSS memory
ceiling, daily upload byte budget and one-hour job ceiling. CPU is sampled relative to total machine
CPU capacity; exceeding the configured threshold stops the job, rather than promising OS scheduling
or a stable throttle. GPU allocated memory is not separately capped; on Apple unified memory, process
RSS is only an approximation of total device pressure. Insufficient available memory rejects startup.
Stop terminates the child and prevents a new upload. An already transmitted network request cannot be
recalled. The current implementation requests one task per Run once; it does not silently auto-recruit
or auto-loop. User programming projects and chats are never the training data source.

## Coordinator startup and principals

Install the normal Python package. For local validation:

```sh
export HEYUNA_DATABASE_URL='sqlite:////absolute/private/path/coordinator.sqlite3'
# Supply HEYUNA_COORDINATOR_IDENTITIES through a private environment or secret manager.
uvicorn heyuna.coordinator:create_legacy_coordinator_app --factory --host 127.0.0.1 --port 8080
```

`HEYUNA_COORDINATOR_IDENTITIES` is a JSON list of objects with `participant_id`, `operator_id`, `role`
(`admin`, `device`, `validator`), Ethereum `wallet`, and unique random `token` (minimum 32 characters).
Tokens must be generated separately, never committed. Require exactly three distinct validator
operator IDs, with no overlap with device operators. Configuration checks cannot establish real human
independence; verify operators organizationally before inviting devices. Restart rotates/revokes these
static invited-alpha tokens. No unauthenticated registration endpoint exists.

Set `HEYUNA_COORDINATOR_HOSTS` to a comma-separated explicit deployment hostname list; wildcard hosts
are rejected. Local defaults permit only loopback names and the test harness. All coordinator endpoints
require a bearer token. Devices cannot create tasks or validate; validators
cannot train through device routes; admin cannot substitute a validator attestation. At the edge, use
TLS, request rate limits, an 8 MiB body cap, bounded timeouts and an explicit host allowlist. Bind only
the documented reverse proxy. FastAPI debug/docs/OpenAPI are disabled. No permissive CORS is enabled.
`services/coordinator/compose.yaml` runs PostgreSQL with a loopback-only service port and non-root
coordinator. Supply a `postgresql+psycopg://...` URL; keep database backups and credentials private.
The PostgreSQL route is implemented via SQLAlchemy but needs a real PostgreSQL deployment smoke.
The image tags in the staging recipe must be resolved and pinned by digest before a deployment release.
Do not infer the CNY 1,000 monthly target is met without a provider-specific budget and measured usage.

## API and state progression

- Admin `POST /v1/tasks`: `TaskBundle {task: TrainingTask, texts, shared_a, base_b}`; both artifacts
  are base64 safetensors, and data is a bounded list of public/authorized texts. `TrainingTask` requires
  explicit `data_source` and `data_license`; this records the administrator's provenance statement and
  does not itself establish the administrator's legal rights to the data.
- Device `POST /v1/tasks/lease {backend}`: gets bundle plus opaque lease; 204 means no task available.
  `POST /v1/tasks/{id}/heartbeat {lease_id}` renews only an unexpired owned lease. Expired work is reassigned.
- Device `POST /v1/tasks/{id}/submit`: lease ID, task hash, result hash, base64 adapter B. Identical retries
  return the original receipt; changed/foreign/expired submissions are rejected. A task has one receipt.
- Validator `GET /v1/receipts/{id}/review`: reads exact task/input/result for independent verification.
  `POST /v1/receipts/{id}/validate`: immutable artifact-bound acceptance/rejection, recomputation and
  held-out booleans, evidence hash and explanation. Any rejection blocks rewards; two distinct accepted
  operators advance to `verified`. An admin cannot overturn rejection through this API.
- Admin `POST /v1/rounds/{round}/aggregate`: only verified results; returns a candidate B artifact.
- Admin `POST /v1/reward-epochs/draft {epoch,receipt_ids}`: only previously unallocated verified receipts;
  allocates the exact integer weekly budget, 90/10 training/validation split. Flooring dust remains
  unallocated. Total reserved drafts cannot exceed 18 million tokens. Drafts are immutable in this alpha;
  a failed/rejected on-chain proposal needs an explicit future reconciled cancellation design, not a
  duplicate draft or manual database edits.
- `GET /v1/receipts` filters devices to their own receipts; `GET /v1/reward-epochs/{epoch}` exposes drafts
  only to authenticated participants. Drafts advance receipts to `pending_settlement`.

The coordinator does not sign or publish Ethereum transactions, produce claim proofs or mark anything
`claimable`/`confirmed`. The contracts enforce actual weekly timing, 72-hour challenge and claim rules.
A reward manifest is an unsigned allocation proposal, not payment or a proof of useful training.
Off-chain validator authentication is separate from on-chain validator keys.

## Validator execution

Download the review bundle into a private job directory (`task.json`, `data.json`, `a.safetensors`,
`b.safetensors`) and save the submitted candidate. Supply separate, validator-owned held-out texts:

```sh
python -m heyuna.training --job-dir /private/job --model-path /prepared/model --backend mlx \
  --candidate /private/job/candidate.safetensors --heldout /private/heldout.json
```

This writes `validation.json` with a full duplicate recomputation check (`atol=1e-5`, `rtol=1e-2`),
held-out baseline/candidate token losses and an evidence hash. Candidate loss must not regress more
than 1%. Exact training/heldout text overlap is rejected. The 1% guard is a conservative alpha screen,
not statistical proof of quality improvement, poisoning resistance or cross-platform numerical
identity. Validators must retain evidence and review data provenance; the API trusts their attestation.
Independent coding benchmarks, backdoor tests, adversarial validators and Sybil resistance remain
mainnet blockers. A valid Merkle proof would establish an allocation, not training correctness.

## Verification and separate evidence gates

```sh
python -m pytest tests/test_protocol.py tests/test_federation.py tests/test_coordinator.py tests/test_training.py
python scripts/federation_smoke.py --model-path /prepared/model --backend mlx \
  --output .local-evidence/federation-smoke --steps 1 --verify
```

The first command uses synthetic adapter values and test-only verifier attestations to exercise
protocol/permission behavior. It does not pretend to train a model. The second performs real local
training; its optional verification runs on the same operator/device and is explicitly not independent.
Record real Mac and Windows NVIDIA tests separately, then a same-round two-device trial, then independent
validators, then testnet transactions. No acceptance gate is closed by fixture success alone.

## Observed local training evidence — 2026-10-25

On this Apple Silicon Mac (`macOS 27.0.1 arm64`), the real pinned BF16 4B smoke completed using
MLX 0.32.4 / mlx-lm 0.30.7 / NumPy 2.5.4 / safetensors 0.8.0. It ran in HF/Transformers offline mode
with an environment allowlist excluding credentials. Ten model/config/tokenizer SHA256 values
matched the fixed official revision before loading.

| Observation | Result |
|---|---|
| Local training | 1 optimizer step, sequence cap 64, 9.371 seconds including load/hash checks |
| Training loss | 2.9477767944 |
| Peak MLX device allocation | 8,102,521,452 bytes (about 7.55 GiB) |
| Adapter SHA256 | `496f8fc4d0c83b0edca48d5488a5447d5d769bd20f4e1b180a533de58472f7eb` |
| Same-device duplicate computation | Identical adapter SHA256 |
| Held-out baseline token loss | 3.4847963121 |
| Held-out candidate token loss | 3.4898088243 |

The held-out loss **worsened by approximately 0.144%**. It was within the configured 1% rejection
tolerance, but this is not a model-quality improvement. The two smoke training texts and one held-out
text are far too small for a quality conclusion. Operator independence was explicitly `false`.
This observation does not close the CUDA, two-physical-device, independent-validator, PostgreSQL
production, public-network, or chain-settlement gates. It is not a network-isolation penetration test.
The reproducible command above writes detailed local metrics and evidence hashes to the ignored
`.local-evidence/federation-smoke/` directory; private runtime files and model weights are not published.
