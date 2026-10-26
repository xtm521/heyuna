# Versioned native-chain protocol

`protocol/*.schema.json` are immutable legacy Alpha messages. Native application schemas are `*.v2.schema.json`. The chain protobuf namespace `/heyuna.contribution.v1.MsgExecute` is a separate internal version; it is not an Alpha receipt format. No automatic legacy-to-native reward conversion exists.

## NetworkManifest v2

Closed schema in`backend/heyuna/deployment.py`. Required: version2; profile research/accelerated-local; EVM chain297011/297012; Cosmos chain; network_domain; genesis_hash; genesis_hash_kind=`sha256-canonical-genesis-json`; evm_anchor={block_number:1,block_hash}; loopback RPC origins; native kind; tHEYUNA/aheyuna/18; genesis supply string; reward/fund/factory/precompile addresses; start timestamp; challenge259200/3; confirmation count; actual runtime hashes. Profile/ID/challenge must agree. No token_address field is used for native assets.

Genesis hash is SHA256(canonical JSON of actual Comet GenesisDoc), prefixed0x; file-byte SHA256 is separate. A trusted distributed manifest binds genesis to EVM block1. Browser checks both canonical Cosmos genesis and its own EIP1193 provider's anchor/code hashes. This does not eliminate trust in the initial manifest, local node or wallet. Numeric genesis fields fromComet are canonical strings/integers; oversized responses fail closed.

## Task and receipt

TrainingTaskV2 binds NetworkBinding={chain_id,genesis_hash,reward_vault_address,network_domain}, recipient and category0/1, in addition to pinned model/tokenizer/data/template/config/round/sharedA/baseB fields. Fingerprint is SHA256 canonical JSON. A closed-schema worker never executes coordinator code. ReceiptV2 includes the same binding, result digest, model/data/template/config hashes, category, participant/recipient and review state. Chain submitter remains an authenticated signer.

V2 coordinator exposes `/v2/*` only when constructed with a trusted native manifest. Legacy factory exposes `/v1/*`. Persisted DB network binding prevents silent reuse. Wallet-directed tasks lease only to matching recipients. Cross-network tasks/receipts and reused raw result hashes are rejected. Review signatures do not themselves create paid recomputation tasks. All drafts remain unsigned and off chain.

Native coordinator reviews require two of the three invited verifier votes for acceptance or rejection. A single rejection leaves the receipt pending and cannot veto two approvals. Each verifier's vote is immutable; rejection quorum and allocated receipts cannot be overwritten. This is distinct from a single-verifier freeze of a disputed on-chain batch. Explicit legacy v1 retains its historical rejection behavior.

## Reward bundle v2

Generator:`contracts/scripts/native-protocol.mjs::nativeBundle`. File keys: manifest,manifest_hash,root,training_budget,verification_budget,claims.

Manifest={version:2,asset_kind:"native",chain_id,genesis_hash,reward_vault,epoch,allocations}. Allocation={index,recipient,category,amount,contribution_id}. Epoch/index/amount are canonical unsigned decimal strings; chain_id/category are integers. Addresses, hashes and contribution IDs normalize lowercase; allocations sort numerically by epoch-global index. Indices cannot repeat across categories.

`manifest_hash` is lowercase SHA256 hex without0x of recursively lexicographically key-sorted, no-whitespace UTF8 JSON. It is an off-chain integrity digest, **not a field committed by getEpoch**. The chain's authoritative root and exact category sums must also match. Hashing an untrusted file alone does not authenticate it.

The root follows OpenZeppelin StandardMerkleTree1.0.8: double-hashed ABI leaves, sorted leaves, complete binary heap and sorted child hashes. Odd-node carry is not interchangeable. Committed 1/2/3/4/5/128-leaf vectors check Go,JS and all proofs. Leaf order:

```solidity
(uint256 chainId,address vault,uint256 epoch,uint8 category,uint256 index,
 address recipient,uint256 amount,bytes32 contributionId)
```

Precompile0x0900: `getEpoch(uint256)`→root,trainingBudget,verificationBudget,finalized; `getNetwork()`→chainId,networkDomain,vault,challengeSeconds,accelerated. View-only bounded/metered calls, no token or arbitrary native write operation.

Vault: `claim(epoch,index,recipient,category,amount,contributionId,proof)`; event `RewardClaimed(epoch indexed,index indexed,recipient indexed,category,amount,contributionId)`. Relay permission cannot alter the recipient. Claim confirmation requires network identity, oracle finality/budgets, proof, runtime hash, receipt status/event and reconciled real balance. Coordinator states cannot assert chain confirmation.

Native amount display requires18decimal scaling; genesis supply differs from current supply after burns, vault balance and circulating/distributed totals. Unverified amounts are “—”. Connecting a wallet, fee preview and signing are separate user actions.

## Recomputation work and deduplication

Category1 application tasks carry verification={receipt_id,chain_receipt_id,adapter_hash}. Coordinator receipt IDs and actual chain IDs are different namespaces; a draft/bridge cannot silently substitute one for the other. Coordinator checks its accepted target, full computation context and distinct trainer/operator; chain independently checks the anchored target, its two approvals and full context. The chain task binds its actual target receipt ID.

An identical recomputed B is expected. Its paid work commitment binds chain/domain/vault/task/worker/target/original artifact/evidence, rather than pretending B changed. Worker evidence commits task/target/artifact/actual metrics; independent verifiers still recompute and evaluate quality. The chain records evidence hashes and cannot establish their truth. Same worker cannot reward the same original artifact again by swapping a target receipt nonce. Coordinator also limits the original artifact per verification operator. Address uniqueness is not proof of independent human control.

Raw training candidates may coexist before acceptance so an attacker cannot reserve a hash by frontrunning an unverified submission. Global raw-result uniqueness is enforced when the quorum reserves a reward batch, including duplicate entries in that batch. Cancellation releases reservations; finalized rights remain. Voting batches without reservations can be cancelled by two verifiers, permitting recovery from a malicious first vote.

JSON Schema expresses structure; runtime cross-field checks (profile/chain/challenge consistency, nonzero/distinct addresses, accepted target and budget/state invariants) remain mandatory. Do not treat schema validity as complete protocol acceptance.
