// SPDX-License-Identifier: Apache-2.0
package contribution

import (
	"errors"
	"math"
	"math/big"
	"strings"

	sdk "github.com/cosmos/cosmos-sdk/types"
)

// CheckInvariants is used for genesis/state restoration and explicit tests. It
// is intentionally not an unbounded per-block scan: transaction paths enforce
// local limits, while export/upgrade tooling can audit the complete history.
func (k Keeper) CheckInvariants(ctx sdk.Context) error {
	c, err := k.Config(ctx)
	if err != nil {
		return err
	}
	if err = c.Validate(); err != nil {
		return err
	}
	tasks := map[string]Task{}
	receipts := map[string]Receipt{}
	epochs := map[uint64]Epoch{}
	results := map[string]string{}
	reservedResults := map[string]string{}
	verificationWork := map[string]string{}
	taskResults := map[string]string{}
	challenges := []Challenge{}
	var accounting Accounting
	it := ctx.KVStore(k.key).Iterator(nil, nil)
	defer it.Close()
	for ; it.Valid(); it.Next() {
		key := string(it.Key())
		value := it.Value()
		switch {
		case key == "config":
			continue
		case key == "accounting":
			if err := strictDecode(value, &accounting); err != nil {
				return err
			}
		case strings.HasPrefix(key, "task/"):
			var v Task
			if err := strictDecode(value, &v); err != nil {
				return err
			}
			if key != "task/"+v.ID {
				return errors.New("task key mismatch")
			}
			tasks[v.ID] = v
		case strings.HasPrefix(key, "receipt/"):
			var v Receipt
			if err := strictDecode(value, &v); err != nil {
				return err
			}
			if key != "receipt/"+v.ID {
				return errors.New("receipt key mismatch")
			}
			receipts[v.ID] = v
		case strings.HasPrefix(key, "epoch/"):
			var v Epoch
			if err := strictDecode(value, &v); err != nil {
				return err
			}
			if key != epochKey(v.ID) {
				return errors.New("epoch key mismatch")
			}
			epochs[v.ID] = v
		case strings.HasPrefix(key, "result/"):
			var id string
			if err := strictDecode(value, &id); err != nil {
				return err
			}
			results[strings.TrimPrefix(key, "result/")] = id
		case strings.HasPrefix(key, "rewarded-result/"):
			var id string
			if err := strictDecode(value, &id); err != nil {
				return err
			}
			reservedResults[strings.TrimPrefix(key, "rewarded-result/")] = id
		case strings.HasPrefix(key, "verification-work/"):
			var id string
			if err := strictDecode(value, &id); err != nil {
				return err
			}
			verificationWork[key] = id
		case strings.HasPrefix(key, "task-result/"):
			var id string
			if err := strictDecode(value, &id); err != nil {
				return err
			}
			taskResults[strings.TrimPrefix(key, "task-result/")] = id
		case strings.HasPrefix(key, "challenge/"):
			var v Challenge
			if err := strictDecode(value, &v); err != nil {
				return err
			}
			if key != "challenge/"+v.ID {
				return errors.New("challenge key mismatch")
			}
			challenges = append(challenges, v)
		default:
			return errors.New("unknown contribution store key")
		}
	}
	for id, t := range tasks {
		if !hashOK(t.ID) || taskCommitment(c, t) != id || !addressOK(t.Submitter) || !addressOK(t.Recipient) || !hashOK(t.ModelHash) || !hashOK(t.DataHash) || !hashOK(t.TemplateHash) || !hashOK(t.ConfigHash) || t.Category > 1 {
			return errors.New("task commitment invariant failed")
		}
		if t.Category == 0 {
			if t.VerificationTarget != "" {
				return errors.New("training task has verification target")
			}
		} else {
			target, exists := receipts[t.VerificationTarget]
			targetTask, taskExists := tasks[target.TaskID]
			if !exists || !taskExists || verificationWork[verificationWorkKey(target.ResultHash, t.Submitter)] != id {
				return errors.New("verification work index invariant failed")
			}
			if err := validateVerificationTask(t, targetTask, target); err != nil {
				return err
			}
		}
	}
	for id, r := range receipts {
		t, exists := tasks[r.TaskID]
		if !exists || receiptCommitment(c, r.TaskID, r.ResultHash) != id || !hashOK(r.ResultHash) || r.Submitter != t.Submitter || r.Recipient != t.Recipient || r.Category != t.Category || taskResults[r.TaskID] != id {
			return errors.New("receipt commitment or result uniqueness invariant failed")
		}
		if r.Category == 0 {
			if r.VerificationTarget != "" || r.ArtifactHash != "" || r.EvidenceHash != "" {
				return errors.New("training receipt has verification-only fields")
			}
		} else {
			target, ok := receipts[r.VerificationTarget]
			if !ok || r.VerificationTarget != t.VerificationTarget || r.ArtifactHash != target.ResultHash || !hashOK(r.EvidenceHash) || r.ResultHash != VerificationResultCommitment(c, t.ID, r.Submitter, r.VerificationTarget, r.ArtifactHash, r.EvidenceHash) {
				return errors.New("verification result commitment invariant failed")
			}
		}
		seen := map[string]bool{}
		if len(r.Reports) > 3 {
			return errors.New("too many receipt reports")
		}
		for _, report := range r.Reports {
			if seen[report.Verifier] || !isVerifier(c, report.Verifier) || report.Verifier == r.Submitter || report.Verifier == r.Recipient || !hashOK(report.ReportHash) {
				return errors.New("receipt verifier independence invariant failed")
			}
			seen[report.Verifier] = true
		}
	}
	for raw, id := range results {
		r, exists := receipts[id]
		if !exists || r.ResultHash != raw {
			return errors.New("orphan historical result index")
		}
	}
	for key, id := range verificationWork {
		task, exists := tasks[id]
		target, targetExists := receipts[task.VerificationTarget]
		if !exists || !targetExists || task.Category != 1 || verificationWorkKey(target.ResultHash, task.Submitter) != key {
			return errors.New("orphan verification work index")
		}
	}
	if len(taskResults) != len(receipts) {
		return errors.New("orphan result index invariant failed")
	}
	train, verify := new(big.Int), new(big.Int)
	allocations := map[string]uint64{}
	allocatedRaw := map[string]string{}
	for id, e := range epochs {
		if len(e.Entries) == 0 || len(e.Entries) > MaxEpochEntries {
			return errors.New("stored epoch size invariant failed")
		}
		root, err := RewardRoot(c, id, e.Entries)
		if err != nil || root.Hex() != e.Root {
			return errors.New("epoch root invariant failed")
		}
		proposal := ProposeEpoch{Epoch: id, Nonce: e.ProposalNonce, Entries: e.Entries}
		digest := canonicalHash(struct {
			Domain, Chain, Vault string
			Proposal             ProposeEpoch
		}{c.NetworkDomain, c.ChainID, strings.ToLower(c.VaultAddress), proposal})
		if digest != e.ProposalHash {
			return errors.New("epoch proposal commitment invariant failed")
		}
		active := e.Status == "pending" || e.Status == "frozen" || e.Status == "finalized"
		if !active && e.Status != "voting" && e.Status != "cancelled" {
			return errors.New("epoch status invariant failed")
		}
		seenApprovals := map[string]bool{}
		for _, v := range e.Approvals {
			if !isVerifier(c, v) || seenApprovals[v] {
				return errors.New("epoch approval invariant failed")
			}
			seenApprovals[v] = true
		}
		if (e.Status == "voting" && len(e.Approvals) != 1) || (e.Status != "voting" && e.Status != "cancelled" && len(e.Approvals) != 2) || (e.Status == "cancelled" && len(e.Approvals) != 1 && len(e.Approvals) != 2) || e.ControlNonce < e.ProposalNonce {
			return errors.New("epoch quorum or nonce invariant failed")
		}
		if e.Status != "voting" && len(e.Approvals) == 2 {
			if id > uint64((math.MaxInt64-c.StartTime)/WeekSeconds) || e.ProposedAt < c.StartTime+int64(id)*WeekSeconds || e.ProposedAt-c.StartTime-int64(id)*WeekSeconds >= WeekSeconds || e.ProposedAt > math.MaxInt64-c.ChallengeSeconds || e.FinalizeAfter < e.ProposedAt+c.ChallengeSeconds || e.ControlNonce <= e.ProposalNonce {
				return errors.New("epoch deadline invariant failed")
			}
		}
		seenVotes := map[string]bool{}
		voteCounts := map[string]int{}
		for _, v := range e.ControlVotes {
			if (e.Status != "frozen" && !(e.Status == "voting" && v.Action == "cancel_epoch")) || seenVotes[v.Verifier] || !isVerifier(c, v.Verifier) || (v.Action != "resume_epoch" && v.Action != "cancel_epoch") {
				return errors.New("epoch control vote invariant failed")
			}
			seenVotes[v.Verifier] = true
			voteCounts[v.Action]++
			if voteCounts[v.Action] >= 2 {
				return errors.New("unexecuted control quorum invariant failed")
			}
		}
		localTrain, localVerify := new(big.Int), new(big.Int)
		seenEntries := map[string]bool{}
		for i, entry := range e.Entries {
			r, exists := receipts[entry.ReceiptID]
			if !exists || entry.Index != uint32(i) || seenEntries[r.ID] || entry.Recipient != r.Recipient || entry.Category != r.Category {
				return errors.New("epoch receipt invariant failed")
			}
			seenEntries[r.ID] = true
			yes := 0
			for _, report := range r.Reports {
				if report.Accept {
					yes++
				}
			}
			if yes < 2 {
				return errors.New("epoch receipt quorum invariant failed")
			}
			a, err := amount(entry.Amount)
			if err != nil || a.Sign() <= 0 {
				return errors.New("epoch amount invariant failed")
			}
			if entry.Category == 0 {
				localTrain.Add(localTrain, a)
			} else {
				localVerify.Add(localVerify, a)
			}
			if active {
				if _, duplicate := allocations[r.ID]; duplicate || !r.Allocated || r.AllocatedEpoch != id {
					return errors.New("receipt double allocation invariant failed")
				}
				allocations[r.ID] = id
				if r.Category == 0 {
					if _, duplicate := allocatedRaw[r.ResultHash]; duplicate {
						return errors.New("training raw hash double reward invariant failed")
					}
					allocatedRaw[r.ResultHash] = r.ID
					if reservedResults[r.ResultHash] != r.ID && results[r.ResultHash] != r.ID {
						return errors.New("missing raw hash reward reservation")
					}
				}
			}
		}
		maxTrain, maxVerify := WeeklyBudget(id)
		if localTrain.String() != e.TrainingBudget || localVerify.String() != e.VerificationBudget || localTrain.Cmp(maxTrain) > 0 || localVerify.Cmp(maxVerify) > 0 {
			return errors.New("epoch budget invariant failed")
		}
		if active {
			train.Add(train, localTrain)
			verify.Add(verify, localVerify)
		}
	}
	for id, r := range receipts {
		_, allocated := allocations[id]
		if r.Allocated != allocated {
			return errors.New("orphan receipt allocation invariant failed")
		}
	}
	for raw, id := range reservedResults {
		if allocatedRaw[raw] != id {
			return errors.New("orphan raw hash reward reservation")
		}
	}
	for _, ch := range challenges {
		if _, exists := epochs[ch.Epoch]; !exists || !addressOK(ch.Challenger) || !hashOK(ch.EvidenceHash) || ch.RegisteredAt < c.StartTime {
			return errors.New("challenge invariant failed")
		}
		id := canonicalHash(struct {
			Domain, Chain, Vault, Challenger, Evidence string
			Epoch                                      uint64
		}{c.NetworkDomain, c.ChainID, strings.ToLower(c.VaultAddress), ch.Challenger, ch.EvidenceHash, ch.Epoch})
		if id != ch.ID {
			return errors.New("challenge commitment invariant failed")
		}
	}
	if train.String() != accounting.TrainingReserved || verify.String() != accounting.VerificationReserved || train.Cmp(TrainingCap()) > 0 || verify.Cmp(VerificationCap()) > 0 {
		return errors.New("contribution accounting invariant failed")
	}
	return nil
}
