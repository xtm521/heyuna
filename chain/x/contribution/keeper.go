// SPDX-License-Identifier: Apache-2.0
package contribution

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"

	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/ethereum/go-ethereum/common"
)

// Keeper only receives its own KVStoreKey. It has no bank mint, burn, transfer,
// staking, arbitrary message execution or network capability.
type Keeper struct{ key *storetypes.KVStoreKey }

func NewKeeper(key *storetypes.KVStoreKey) Keeper { return Keeper{key: key} }
func (k Keeper) put(ctx sdk.Context, key string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	ctx.KVStore(k.key).Set([]byte(key), b)
}
func (k Keeper) get(ctx sdk.Context, key string, v any) bool {
	b := ctx.KVStore(k.key).Get([]byte(key))
	if b == nil {
		return false
	}
	if err := json.Unmarshal(b, v); err != nil {
		panic(fmt.Errorf("corrupt contribution state %q: %w", key, err))
	}
	return true
}
func (k Keeper) Config(ctx sdk.Context) (Config, error) {
	var c Config
	if !k.get(ctx, "config", &c) {
		return c, errors.New("contribution module is not initialized")
	}
	return c, nil
}
func (k Keeper) Task(ctx sdk.Context, id string) (Task, error) {
	var t Task
	if !hashOK(id) || !k.get(ctx, "task/"+NormalizeHash(id), &t) {
		return t, errors.New("task not found")
	}
	return t, nil
}
func (k Keeper) Receipt(ctx sdk.Context, id string) (Receipt, error) {
	var r Receipt
	if !hashOK(id) || !k.get(ctx, "receipt/"+NormalizeHash(id), &r) {
		return r, errors.New("receipt not found")
	}
	return r, nil
}
func epochKey(id uint64) string { return fmt.Sprintf("epoch/%020d", id) }
func (k Keeper) Epoch(ctx sdk.Context, id uint64) (Epoch, error) {
	var e Epoch
	if !k.get(ctx, epochKey(id), &e) {
		return e, errors.New("epoch not found")
	}
	return e, nil
}
func (k Keeper) Challenge(ctx sdk.Context, id string) (Challenge, error) {
	var c Challenge
	if !hashOK(id) || !k.get(ctx, "challenge/"+NormalizeHash(id), &c) {
		return c, errors.New("challenge not found")
	}
	return c, nil
}
func (k Keeper) Accounting(ctx sdk.Context) Accounting {
	var a Accounting
	if !k.get(ctx, "accounting", &a) {
		a = Accounting{"0", "0"}
	}
	return a
}

func (k Keeper) InitGenesis(ctx sdk.Context, gs GenesisState) error {
	if err := ValidateGenesis(gs); err != nil {
		return err
	}
	if ctx.ChainID() != gs.Config.ChainID {
		return errors.New("SDK chain ID disagrees with contribution genesis")
	}
	if ctx.KVStore(k.key).Has([]byte("config")) {
		return errors.New("module already initialized")
	}
	cache, commit := ctx.CacheContext()
	k.put(cache, "config", gs.Config)
	k.put(cache, "accounting", Accounting{"0", "0"})
	for _, r := range gs.Records {
		cache.KVStore(k.key).Set([]byte(r.Key), r.Value)
	}
	if err := k.CheckInvariants(cache); err != nil {
		return err
	}
	commit()
	return nil
}
func ValidateGenesis(gs GenesisState) error {
	if err := gs.Config.Validate(); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, r := range gs.Records {
		if seen[r.Key] || r.Key == "config" || len(r.Key) > 160 || len(r.Value) > MaxPayloadBytes*4 || !json.Valid(r.Value) {
			return errors.New("invalid exported contribution record")
		}
		seen[r.Key] = true
		if r.Key != "accounting" && !strings.HasPrefix(r.Key, "task/") && !strings.HasPrefix(r.Key, "receipt/") && !strings.HasPrefix(r.Key, "result/") && !strings.HasPrefix(r.Key, "rewarded-result/") && !strings.HasPrefix(r.Key, "verification-work/") && !strings.HasPrefix(r.Key, "task-result/") && !strings.HasPrefix(r.Key, "epoch/") && !strings.HasPrefix(r.Key, "challenge/") {
			return errors.New("unknown contribution state prefix")
		}
	}
	return nil
}
func (k Keeper) ExportGenesis(ctx sdk.Context) GenesisState {
	c, err := k.Config(ctx)
	if err != nil {
		panic(err)
	}
	gs := GenesisState{Config: c}
	it := ctx.KVStore(k.key).Iterator(nil, nil)
	defer it.Close()
	for ; it.Valid(); it.Next() {
		if string(it.Key()) != "config" {
			gs.Records = append(gs.Records, Record{Key: string(it.Key()), Value: append([]byte(nil), it.Value()...)})
		}
	}
	return gs
}

func isVerifier(c Config, sender string) bool {
	for _, v := range c.Verifiers {
		if common.HexToAddress(v) == common.HexToAddress(sender) {
			return true
		}
	}
	return false
}
func authenticatedAddress(sender string) (string, error) {
	a, err := sdk.AccAddressFromBech32(sender)
	if err != nil || len(a) != 20 {
		return "", errors.New("sender must be an authenticated 20-byte Cosmos account")
	}
	return strings.ToLower(common.BytesToAddress(a).Hex()), nil
}
func (k Keeper) Execute(ctx sdk.Context, sender string, payload []byte) (string, error) {
	if len(payload) == 0 || len(payload) > MaxPayloadBytes {
		return "", errors.New("contribution payload size out of bounds")
	}
	c, err := k.Config(ctx)
	if err != nil {
		return "", err
	}
	s, err := authenticatedAddress(sender)
	if err != nil {
		return "", err
	}
	var e Envelope
	if err = strictDecode(payload, &e); err != nil {
		return "", err
	}
	if e.Version != ProtocolVersion || e.ChainID != ctx.ChainID() || e.ChainID != c.ChainID || NormalizeHash(e.NetworkDomain) != NormalizeHash(c.NetworkDomain) || !addressOK(e.VaultAddress) || common.HexToAddress(e.VaultAddress) != common.HexToAddress(c.VaultAddress) {
		return "", errors.New("contribution domain mismatch")
	}
	var id string
	switch e.Kind {
	case "submit_task":
		var v SubmitTask
		if err = strictDecode(e.Body, &v); err == nil {
			id, err = k.submitTask(ctx, c, s, v)
		}
	case "submit_result":
		var v SubmitResult
		if err = strictDecode(e.Body, &v); err == nil {
			id, err = k.submitResult(ctx, c, s, v)
		}
	case "submit_report":
		var v SubmitReport
		if err = strictDecode(e.Body, &v); err == nil {
			id, err = k.submitReport(ctx, c, s, v)
		}
	case "propose_epoch":
		var v ProposeEpoch
		if err = strictDecode(e.Body, &v); err == nil {
			id, err = k.proposeEpoch(ctx, c, s, v)
		}
	case "challenge":
		var v ChallengeInput
		if err = strictDecode(e.Body, &v); err == nil {
			id, err = k.registerChallenge(ctx, c, s, v)
		}
	case "freeze_epoch", "resume_epoch", "cancel_epoch":
		var v ControlEpoch
		if err = strictDecode(e.Body, &v); err == nil {
			id, err = k.controlEpoch(ctx, c, s, e.Kind, v)
		}
	case "finalize_epoch":
		var v EpochRef
		if err = strictDecode(e.Body, &v); err == nil {
			id, err = k.finalize(ctx, c, v.Epoch)
		}
	default:
		err = errors.New("unsupported contribution operation")
	}
	if err == nil {
		ctx.EventManager().EmitEvent(sdk.NewEvent("heyuna.contribution", sdk.NewAttribute("operation", e.Kind), sdk.NewAttribute("id", id)))
	}
	return id, err
}

func taskCommitment(c Config, t Task) string {
	t.ID = ""
	return canonicalHash(struct {
		Domain string `json:"domain"`
		Chain  string `json:"chain"`
		Vault  string `json:"vault"`
		Task   Task   `json:"task"`
	}{c.NetworkDomain, c.ChainID, strings.ToLower(c.VaultAddress), t})
}
func (k Keeper) submitTask(ctx sdk.Context, c Config, s string, v SubmitTask) (string, error) {
	if !hashOK(v.ModelHash) || !hashOK(v.DataHash) || !hashOK(v.TemplateHash) || !hashOK(v.ConfigHash) || !addressOK(v.Recipient) || v.Category > 1 {
		return "", errors.New("invalid task commitment")
	}
	t := Task{Submitter: s, ModelHash: NormalizeHash(v.ModelHash), DataHash: NormalizeHash(v.DataHash), TemplateHash: NormalizeHash(v.TemplateHash), ConfigHash: NormalizeHash(v.ConfigHash), Round: v.Round, Recipient: strings.ToLower(v.Recipient), Category: v.Category, Nonce: v.Nonce, VerificationTarget: NormalizeHash(v.VerificationTarget)}
	if t.Category == 0 && t.VerificationTarget != "" {
		return "", errors.New("training tasks cannot claim a verification target")
	}
	if t.Category == 1 {
		if !hashOK(t.VerificationTarget) {
			return "", errors.New("verification work requires an accepted training target")
		}
		target, err := k.Receipt(ctx, t.VerificationTarget)
		if err != nil {
			return "", err
		}
		targetTask, err := k.Task(ctx, target.TaskID)
		if err != nil {
			return "", err
		}
		if err := validateVerificationTask(t, targetTask, target); err != nil {
			return "", err
		}
		if ctx.KVStore(k.key).Has([]byte(verificationWorkKey(target.ResultHash, s))) {
			return "", errors.New("verification target already assigned to this worker")
		}
	}
	t.ID = taskCommitment(c, t)
	if ctx.KVStore(k.key).Has([]byte("task/" + t.ID)) {
		return "", errors.New("duplicate task commitment")
	}
	k.put(ctx, "task/"+t.ID, t)
	if t.Category == 1 {
		target, _ := k.Receipt(ctx, t.VerificationTarget)
		k.put(ctx, verificationWorkKey(target.ResultHash, s), t.ID)
	}
	return t.ID, nil
}
func (k Keeper) submitResult(ctx sdk.Context, c Config, s string, v SubmitResult) (string, error) {
	t, err := k.Task(ctx, v.TaskID)
	if err != nil {
		return "", err
	}
	if t.Submitter != s {
		return "", errors.New("result signer or hash invalid")
	}
	if ctx.KVStore(k.key).Has([]byte("task-result/" + t.ID)) {
		return "", errors.New("duplicate task result")
	}
	h := NormalizeHash(v.ResultHash)
	if t.Category == 0 {
		if !hashOK(h) || v.VerificationTarget != "" || v.ArtifactHash != "" || v.EvidenceHash != "" {
			return "", errors.New("training result requires only its raw artifact hash")
		}
	} else {
		if v.ResultHash != "" || NormalizeHash(v.VerificationTarget) != t.VerificationTarget || !hashOK(v.ArtifactHash) || !hashOK(v.EvidenceHash) {
			return "", errors.New("verification result requires its bound target, artifact and evidence hashes")
		}
		target, err := k.Receipt(ctx, t.VerificationTarget)
		if err != nil {
			return "", err
		}
		if target.ResultHash != NormalizeHash(v.ArtifactHash) {
			return "", errors.New("verification artifact differs from the training target")
		}
		h = VerificationResultCommitment(c, t.ID, s, t.VerificationTarget, NormalizeHash(v.ArtifactHash), NormalizeHash(v.EvidenceHash))
	}
	id := receiptCommitment(c, t.ID, h)
	r := Receipt{ID: id, TaskID: t.ID, ResultHash: h, Submitter: s, Recipient: t.Recipient, Category: t.Category, Reports: []Report{}}
	if t.Category == 1 {
		r.VerificationTarget = t.VerificationTarget
		r.ArtifactHash = NormalizeHash(v.ArtifactHash)
		r.EvidenceHash = NormalizeHash(v.EvidenceHash)
	}
	k.put(ctx, "receipt/"+id, r)
	k.put(ctx, "task-result/"+t.ID, id)
	// Raw hashes are reserved only by a two-verifier reward quorum, not by an
	// unaudited submission. A mempool observer cannot permanently occupy a hash.
	return id, nil
}

func verificationWorkKey(artifactHash, worker string) string {
	return "verification-work/" + artifactHash + "/" + worker
}
func acceptedReports(r Receipt) int {
	n := 0
	for _, report := range r.Reports {
		if report.Accept {
			n++
		}
	}
	return n
}
func validateVerificationTask(t Task, targetTask Task, target Receipt) error {
	if target.Category != 0 || acceptedReports(target) < 2 {
		return errors.New("verification target is not an accepted training receipt")
	}
	if t.Submitter == target.Submitter || t.Submitter == target.Recipient || t.Recipient == target.Submitter || t.Recipient == target.Recipient {
		return errors.New("verification worker and recipient must differ from the original trainer")
	}
	if t.ModelHash != targetTask.ModelHash || t.DataHash != targetTask.DataHash || t.TemplateHash != targetTask.TemplateHash || t.ConfigHash != targetTask.ConfigHash || t.Round != targetTask.Round {
		return errors.New("verification task differs from its target computation")
	}
	return nil
}

// VerificationResultCommitment uses canonical sorted-key JSON, so non-Go
// clients can reproduce it exactly without relying on Go struct field order.
func VerificationResultCommitment(c Config, taskID, worker, target, artifact, evidence string) string {
	return canonicalHash(map[string]any{"version": 1, "domain": strings.ToLower(c.NetworkDomain), "chain_id": c.ChainID, "evm_chain_id": c.EVMChainID, "vault": strings.ToLower(c.VaultAddress), "task_id": NormalizeHash(taskID), "worker": strings.ToLower(worker), "verification_target": NormalizeHash(target), "artifact_hash": NormalizeHash(artifact), "evidence_hash": NormalizeHash(evidence)})
}

func (k Keeper) rawHashReserved(ctx sdk.Context, raw string) bool {
	if ctx.KVStore(k.key).Has([]byte("rewarded-result/" + raw)) {
		return true
	}
	// Pre-upgrade local research states used result/H at submission. Honor an
	// already allocated historical receipt while ignoring unaudited occupiers.
	var oldID string
	if k.get(ctx, "result/"+raw, &oldID) {
		old, err := k.Receipt(ctx, oldID)
		return err == nil && old.Category == 0 && old.Allocated
	}
	return false
}

func receiptCommitment(c Config, taskID, resultHash string) string {
	return canonicalHash(struct{ Domain, Chain, Vault, Task, Result string }{c.NetworkDomain, c.ChainID, strings.ToLower(c.VaultAddress), taskID, resultHash})
}
func (k Keeper) submitReport(ctx sdk.Context, c Config, s string, v SubmitReport) (string, error) {
	if !isVerifier(c, s) || !hashOK(v.ReportHash) {
		return "", errors.New("only invited verifiers may submit valid report commitments")
	}
	r, err := k.Receipt(ctx, v.ReceiptID)
	if err != nil {
		return "", err
	}
	if r.Allocated || r.Submitter == s || strings.EqualFold(r.Recipient, s) {
		return "", errors.New("allocated receipt or self-verification")
	}
	for _, report := range r.Reports {
		if report.Verifier == s {
			return "", errors.New("verifier already reported on receipt")
		}
	}
	r.Reports = append(r.Reports, Report{s, NormalizeHash(v.ReportHash), v.Accept})
	k.put(ctx, "receipt/"+r.ID, r)
	return r.ID, nil
}
func (k Keeper) validateEntries(ctx sdk.Context, c Config, v ProposeEpoch) (string, string, string, error) {
	if len(v.Entries) == 0 || len(v.Entries) > MaxEpochEntries {
		return "", "", "", errors.New("epoch entry count out of bounds")
	}
	train, verify := new(big.Int), new(big.Int)
	seen := map[string]bool{}
	seenTrainingHashes := map[string]bool{}
	for i, e := range v.Entries {
		if e.Index != uint32(i) {
			return "", "", "", errors.New("entry indices must be unique contiguous positions")
		}
		if err := validateEntry(e); err != nil {
			return "", "", "", err
		}
		r, err := k.Receipt(ctx, e.ReceiptID)
		if err != nil {
			return "", "", "", err
		}
		if r.Allocated || seen[r.ID] || e.Category != r.Category || common.HexToAddress(e.Recipient) != common.HexToAddress(r.Recipient) {
			return "", "", "", errors.New("duplicate, allocated or mismatched reward receipt")
		}
		seen[r.ID] = true
		if r.Category == 0 {
			if seenTrainingHashes[r.ResultHash] || k.rawHashReserved(ctx, r.ResultHash) {
				return "", "", "", errors.New("training result hash already reserved for reward")
			}
			seenTrainingHashes[r.ResultHash] = true
		}
		yes := 0
		for _, report := range r.Reports {
			if report.Accept {
				yes++
			}
		}
		if yes < 2 {
			return "", "", "", errors.New("receipt lacks two independent invited-verifier approvals")
		}
		a, _ := amount(e.Amount)
		if e.Category == 0 {
			train.Add(train, a)
		} else {
			verify.Add(verify, a)
		}
	}
	trainMax, verifyMax := WeeklyBudget(v.Epoch)
	if train.Cmp(trainMax) > 0 || verify.Cmp(verifyMax) > 0 {
		return "", "", "", errors.New("weekly category budget exceeded")
	}
	a := k.Accounting(ctx)
	tr, _ := amount(a.TrainingReserved)
	vr, _ := amount(a.VerificationReserved)
	if new(big.Int).Add(tr, train).Cmp(TrainingCap()) > 0 || new(big.Int).Add(vr, verify).Cmp(VerificationCap()) > 0 {
		return "", "", "", errors.New("cumulative contribution budget exceeded")
	}
	root, err := RewardRoot(c, v.Epoch, v.Entries)
	if err != nil {
		return "", "", "", err
	}
	return root.Hex(), train.String(), verify.String(), nil
}
func (k Keeper) proposeEpoch(ctx sdk.Context, c Config, s string, v ProposeEpoch) (string, error) {
	if !isVerifier(c, s) {
		return "", errors.New("only invited verifiers can approve an epoch")
	}
	if ctx.BlockTime().Unix() < c.StartTime || v.Epoch != uint64((ctx.BlockTime().Unix()-c.StartTime)/WeekSeconds) {
		return "", errors.New("proposals must use the current release week; past and future weeks are closed")
	}
	for i := range v.Entries {
		v.Entries[i].ReceiptID = NormalizeHash(v.Entries[i].ReceiptID)
		v.Entries[i].Recipient = strings.ToLower(v.Entries[i].Recipient)
	}
	digest := canonicalHash(struct {
		Domain, Chain, Vault string
		Proposal             ProposeEpoch
	}{c.NetworkDomain, c.ChainID, strings.ToLower(c.VaultAddress), v})
	e, foundErr := k.Epoch(ctx, v.Epoch)
	if foundErr == nil && e.Status != "cancelled" {
		if e.Status != "voting" || e.ProposalHash != digest || e.ControlNonce != v.Nonce {
			return "", errors.New("epoch cannot be overwritten")
		}
		for _, a := range e.Approvals {
			if a == s {
				return "", errors.New("duplicate epoch approval")
			}
		}
	}
	if (foundErr != nil && v.Nonce != 0) || (foundErr == nil && e.Status == "cancelled" && v.Nonce != e.ControlNonce) {
		return "", errors.New("proposal requires the fresh epoch nonce")
	}
	root, train, verify, err := k.validateEntries(ctx, c, v)
	if err != nil {
		return "", err
	}
	if foundErr != nil || e.Status == "cancelled" {
		e = Epoch{ID: v.Epoch, Root: root, TrainingBudget: train, VerificationBudget: verify, Entries: v.Entries, ProposalHash: digest, ProposalNonce: v.Nonce, Status: "voting", Approvals: []string{}, ControlNonce: v.Nonce}
	}
	e.Approvals = append(e.Approvals, s)
	if len(e.Approvals) == 2 {
		if ctx.BlockTime().Unix() > math.MaxInt64-c.ChallengeSeconds {
			return "", errors.New("block time overflow")
		}
		if e.ControlNonce == math.MaxUint64 {
			return "", errors.New("epoch control nonce exhausted")
		}
		e.Status = "pending"
		e.ProposedAt = ctx.BlockTime().Unix()
		e.FinalizeAfter = e.ProposedAt + c.ChallengeSeconds
		e.ControlNonce++
		e.ControlVotes = nil // Any voting-phase cancellation vote belongs to the previous nonce.
		a := k.Accounting(ctx)
		tr, _ := amount(a.TrainingReserved)
		vr, _ := amount(a.VerificationReserved)
		t, _ := amount(train)
		w, _ := amount(verify)
		a.TrainingReserved = tr.Add(tr, t).String()
		a.VerificationReserved = vr.Add(vr, w).String()
		for _, entry := range e.Entries {
			r, _ := k.Receipt(ctx, entry.ReceiptID)
			r.Allocated = true
			r.AllocatedEpoch = e.ID
			k.put(ctx, "receipt/"+r.ID, r)
			if r.Category == 0 {
				k.put(ctx, "rewarded-result/"+r.ResultHash, r.ID)
			}
		}
		k.put(ctx, "accounting", a)
	}
	k.put(ctx, epochKey(e.ID), e)
	return strconv.FormatUint(e.ID, 10), nil
}
func (k Keeper) registerChallenge(ctx sdk.Context, c Config, s string, v ChallengeInput) (string, error) {
	e, err := k.Epoch(ctx, v.Epoch)
	if err != nil {
		return "", err
	}
	if (e.Status != "pending" && e.Status != "frozen") || !hashOK(v.EvidenceHash) {
		return "", errors.New("epoch is not challengeable")
	}
	h := NormalizeHash(v.EvidenceHash)
	id := canonicalHash(struct {
		Domain, Chain, Vault, Challenger, Evidence string
		Epoch                                      uint64
	}{c.NetworkDomain, c.ChainID, strings.ToLower(c.VaultAddress), s, h, v.Epoch})
	if ctx.KVStore(k.key).Has([]byte("challenge/" + id)) {
		return "", errors.New("duplicate challenge")
	}
	k.put(ctx, "challenge/"+id, Challenge{id, v.Epoch, s, h, ctx.BlockTime().Unix()})
	// Public evidence registration deliberately does not mutate epoch status.
	return id, nil
}
func (k Keeper) controlEpoch(ctx sdk.Context, c Config, s, action string, v ControlEpoch) (string, error) {
	if !isVerifier(c, s) {
		return "", errors.New("epoch control requires an invited verifier")
	}
	e, err := k.Epoch(ctx, v.Epoch)
	if err != nil {
		return "", err
	}
	if e.Status == "finalized" || e.Status == "cancelled" || e.ControlNonce != v.Nonce {
		return "", errors.New("stale control nonce or immutable epoch")
	}
	if e.ControlNonce == math.MaxUint64 {
		return "", errors.New("epoch control nonce exhausted")
	}
	if action == "freeze_epoch" {
		if e.Status != "pending" {
			return "", errors.New("only pending epochs may be frozen")
		}
		e.Status = "frozen"
		e.ControlNonce++
		e.ControlVotes = nil
	} else {
		if e.Status != "frozen" && !(e.Status == "voting" && action == "cancel_epoch") {
			return "", errors.New("resume requires a frozen epoch; cancel requires a frozen or voting epoch")
		}
		for _, vote := range e.ControlVotes {
			if vote.Verifier == s {
				return "", errors.New("duplicate or conflicting control vote")
			}
		}
		e.ControlVotes = append(e.ControlVotes, ControlVote{s, action})
		count := 0
		for _, vote := range e.ControlVotes {
			if vote.Action == action {
				count++
			}
		}
		if count >= 2 {
			if action == "resume_epoch" {
				if ctx.BlockTime().Unix() > math.MaxInt64-c.ChallengeSeconds {
					return "", errors.New("block time overflow")
				}
				e.Status = "pending"
				e.FinalizeAfter = ctx.BlockTime().Unix() + c.ChallengeSeconds
			} else {
				wasReserved := e.Status != "voting"
				e.Status = "cancelled"
				if wasReserved {
					a := k.Accounting(ctx)
					tr, _ := amount(a.TrainingReserved)
					vr, _ := amount(a.VerificationReserved)
					t, _ := amount(e.TrainingBudget)
					w, _ := amount(e.VerificationBudget)
					a.TrainingReserved = tr.Sub(tr, t).String()
					a.VerificationReserved = vr.Sub(vr, w).String()
					k.put(ctx, "accounting", a)
					for _, entry := range e.Entries {
						r, _ := k.Receipt(ctx, entry.ReceiptID)
						r.Allocated = false
						r.AllocatedEpoch = 0
						k.put(ctx, "receipt/"+r.ID, r)
						if r.Category == 0 {
							var reserved string
							if k.get(ctx, "rewarded-result/"+r.ResultHash, &reserved) && reserved == r.ID {
								ctx.KVStore(k.key).Delete([]byte("rewarded-result/" + r.ResultHash))
							}
						}
					}
				}
			}
			e.ControlNonce++
			e.ControlVotes = nil
		}
	}
	k.put(ctx, epochKey(e.ID), e)
	return strconv.FormatUint(e.ID, 10), nil
}
func (k Keeper) finalize(ctx sdk.Context, c Config, id uint64) (string, error) {
	e, err := k.Epoch(ctx, id)
	if err != nil {
		return "", err
	}
	if e.Status != "pending" || ctx.BlockTime().Unix() < e.FinalizeAfter {
		return "", errors.New("epoch is frozen, immutable, or within challenge period")
	}
	if e.ControlNonce == math.MaxUint64 {
		return "", errors.New("epoch control nonce exhausted")
	}
	e.Status = "finalized"
	e.ControlNonce++
	e.ControlVotes = nil
	k.put(ctx, epochKey(e.ID), e)
	return strconv.FormatUint(id, 10), nil
}
