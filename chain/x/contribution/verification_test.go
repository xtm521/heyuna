// SPDX-License-Identifier: Apache-2.0
package contribution

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func verificationTaskFor(t Task, target, recipient string) SubmitTask {
	return SubmitTask{ModelHash: t.ModelHash, DataHash: t.DataHash, TemplateHash: t.TemplateHash, ConfigHash: t.ConfigHash, Round: t.Round, Recipient: recipient, Category: 1, Nonce: 21, VerificationTarget: target}
}

func TestIndependentVerificationUsesEvidenceBoundResultNotDuplicateBHash(t *testing.T) {
	f := newFixture(t)
	target := f.accepted(0, 0)
	original, err := f.k.Task(f.ctx, target.TaskID)
	require.NoError(t, err)
	v := verificationTaskFor(original, target.ID, f.keys[4])
	vid := f.must(4, "submit_task", v)
	v.Nonce++
	_, err = f.exec(4, "submit_task", v)
	require.ErrorContains(t, err, "already assigned")
	_, err = f.exec(4, "submit_result", SubmitResult{TaskID: vid, ResultHash: target.ResultHash})
	require.ErrorContains(t, err, "bound target")
	_, err = f.exec(4, "submit_result", SubmitResult{TaskID: vid, VerificationTarget: target.ID, ArtifactHash: target.ResultHash})
	require.ErrorContains(t, err, "evidence")
	_, err = f.exec(4, "submit_result", SubmitResult{TaskID: vid, VerificationTarget: target.ID, ArtifactHash: testHash(13), EvidenceHash: testHash(12)})
	require.ErrorContains(t, err, "differs")
	rid := f.must(4, "submit_result", SubmitResult{TaskID: vid, VerificationTarget: target.ID, ArtifactHash: target.ResultHash, EvidenceHash: testHash(12)})
	r, err := f.k.Receipt(f.ctx, rid)
	require.NoError(t, err)
	require.Equal(t, target.ResultHash, r.ArtifactHash)
	require.NotEqual(t, target.ResultHash, r.ResultHash)
	require.Equal(t, VerificationResultCommitment(f.c, vid, f.keys[4], target.ID, target.ResultHash, testHash(12)), r.ResultHash)
	f.must(0, "submit_report", SubmitReport{rid, testHash(10), true})
	f.must(1, "submit_report", SubmitReport{rid, testHash(11), true})
	entries := []Entry{{0, target.ID, 0, "1000000000000000000", target.Recipient}, {1, rid, 1, "100000000000000000", r.Recipient}}
	p := ProposeEpoch{Epoch: 0, Entries: entries}
	f.must(0, "propose_epoch", p)
	f.must(1, "propose_epoch", p)
	e, err := f.k.Epoch(f.ctx, 0)
	require.NoError(t, err)
	require.Equal(t, "100000000000000000", e.VerificationBudget)
	f.ctx = f.ctx.WithBlockTime(time.Unix(e.FinalizeAfter, 0))
	f.must(3, "finalize_epoch", EpochRef{0})
	require.NoError(t, f.k.CheckInvariants(f.ctx))
	gs := f.k.ExportGenesis(f.ctx)
	require.NoError(t, ValidateGenesis(gs))
}

func TestVerificationTargetEligibilityAndComputationCannotBeSubstituted(t *testing.T) {
	f := newFixture(t)
	target := f.accepted(0, 0)
	original, _ := f.k.Task(f.ctx, target.TaskID)
	v := verificationTaskFor(original, target.ID, f.keys[4])
	_, err := f.exec(3, "submit_task", v)
	require.ErrorContains(t, err, "original trainer")
	v.Recipient = target.Recipient
	_, err = f.exec(4, "submit_task", v)
	require.ErrorContains(t, err, "original trainer")
	v.Recipient = f.keys[4]
	v.ConfigHash = testHash(14)
	_, err = f.exec(4, "submit_task", v)
	require.ErrorContains(t, err, "target computation")
	v.ConfigHash = original.ConfigHash
	v.VerificationTarget = testHash(15)
	_, err = f.exec(4, "submit_task", v)
	require.ErrorContains(t, err, "not found")
	v.VerificationTarget = ""
	_, err = f.exec(4, "submit_task", v)
	require.ErrorContains(t, err, "accepted training target")
	v.Category = 0
	v.VerificationTarget = target.ID
	_, err = f.exec(4, "submit_task", v)
	require.ErrorContains(t, err, "cannot claim")
}

func TestUnauditedRawHashCannotGriefHonestWorkButRewardsRemainUnique(t *testing.T) {
	f := newFixture(t)
	honest := f.accepted(0, 0)
	original, _ := f.k.Task(f.ctx, honest.TaskID)
	v := SubmitTask{ModelHash: original.ModelHash, DataHash: original.DataHash, TemplateHash: original.TemplateHash, ConfigHash: original.ConfigHash, Round: original.Round, Recipient: f.keys[4], Nonce: 7}
	tid := f.must(4, "submit_task", v)
	copied := f.must(4, "submit_result", SubmitResult{TaskID: tid, ResultHash: honest.ResultHash})
	// Simulate a pre-upgrade index pointing at an unapproved copy. This does not
	// reserve the artifact and cannot block the honest two-verifier epoch.
	f.k.put(f.ctx, "result/"+honest.ResultHash, copied)
	f.pending(honest)
	require.True(t, f.k.rawHashReserved(f.ctx, honest.ResultHash))
	require.NoError(t, f.k.CheckInvariants(f.ctx))
	f.must(0, "submit_report", SubmitReport{copied, testHash(10), true})
	f.must(1, "submit_report", SubmitReport{copied, testHash(11), true})
	f.must(2, "freeze_epoch", ControlEpoch{0, 1})
	f.must(0, "cancel_epoch", ControlEpoch{0, 2})
	f.must(1, "cancel_epoch", ControlEpoch{0, 2})
	require.False(t, f.k.rawHashReserved(f.ctx, honest.ResultHash))
	entries := []Entry{{0, honest.ID, 0, "1", honest.Recipient}, {1, copied, 0, "1", f.keys[4]}}
	_, err := f.exec(0, "propose_epoch", ProposeEpoch{Epoch: 0, Nonce: 3, Entries: entries})
	require.ErrorContains(t, err, "already reserved")
	p := ProposeEpoch{Epoch: 0, Nonce: 3, Entries: entries[:1]}
	f.must(0, "propose_epoch", p)
	f.must(1, "propose_epoch", p)
	e, _ := f.k.Epoch(f.ctx, 0)
	f.ctx = f.ctx.WithBlockTime(time.Unix(e.FinalizeAfter, 0))
	f.must(3, "finalize_epoch", EpochRef{0})
	f.ctx = f.ctx.WithBlockTime(time.Unix(f.c.StartTime+WeekSeconds, 0))
	_, err = f.exec(0, "propose_epoch", ProposeEpoch{Epoch: 1, Entries: []Entry{{0, copied, 0, "1", f.keys[4]}}})
	require.ErrorContains(t, err, "already reserved")
	require.NoError(t, f.k.CheckInvariants(f.ctx))
}

func TestLegacyFinalizedRawHashAndTaskIDsSurviveNewVerificationFields(t *testing.T) {
	f := newFixture(t)
	r := f.accepted(0, 0)
	e := f.pending(r)
	f.ctx = f.ctx.WithBlockTime(time.Unix(e.FinalizeAfter, 0))
	f.must(4, "finalize_epoch", EpochRef{0})
	f.k.put(f.ctx, "result/"+r.ResultHash, r.ID)
	f.ctx.KVStore(f.k.key).Delete([]byte("rewarded-result/" + r.ResultHash))
	require.True(t, f.k.rawHashReserved(f.ctx, r.ResultHash))
	require.NoError(t, f.k.CheckInvariants(f.ctx))
	task, _ := f.k.Task(f.ctx, r.TaskID)
	require.Empty(t, task.VerificationTarget)
	// Empty verification fields remain omitted in the exact historical JSON.
	b := canonicalHash(task)
	require.NotEmpty(t, b)
	require.False(t, strings.Contains(string(f.ctx.KVStore(f.k.key).Get([]byte("task/"+task.ID))), "verification_target"))
}

func TestVerificationTargetAliasesCannotRewardTheSameWorkerTwice(t *testing.T) {
	f := newFixture(t)
	target := f.accepted(0, 0)
	original, _ := f.k.Task(f.ctx, target.TaskID)
	alias := SubmitTask{ModelHash: original.ModelHash, DataHash: original.DataHash, TemplateHash: original.TemplateHash, ConfigHash: original.ConfigHash, Round: original.Round, Recipient: original.Recipient, Nonce: 99}
	aliasTask := f.must(3, "submit_task", alias)
	aliasReceipt := f.must(3, "submit_result", SubmitResult{TaskID: aliasTask, ResultHash: target.ResultHash})
	f.must(0, "submit_report", SubmitReport{aliasReceipt, testHash(10), true})
	f.must(1, "submit_report", SubmitReport{aliasReceipt, testHash(11), true})
	v := verificationTaskFor(original, target.ID, f.keys[4])
	f.must(4, "submit_task", v)
	v.VerificationTarget = aliasReceipt
	v.Nonce++
	_, err := f.exec(4, "submit_task", v)
	require.ErrorContains(t, err, "already assigned")
	// Another worker may perform genuinely separate recomputation. Its own two
	// independent report approvals and verification category budget still apply.
	v.Recipient = f.keys[2]
	f.must(2, "submit_task", v)
	require.NoError(t, f.k.CheckInvariants(f.ctx))
}

func TestPythonVerificationResultCommitmentInteroperability(t *testing.T) {
	c := Config{ChainID: "heyuna_297012-1", EVMChainID: 297012, NetworkDomain: "0x" + strings.Repeat("99", 32), VaultAddress: "0x0000000000000000000000000000000000001000"}
	actual := VerificationResultCommitment(c, "0x"+strings.Repeat("11", 32), "0x"+strings.Repeat("22", 20), "0x"+strings.Repeat("33", 32), "0x"+strings.Repeat("44", 32), "0x"+strings.Repeat("55", 32))
	require.Equal(t, "0x8e35b66014fd11678183acf84f1fadbc06baaa4cf77354c62910c80c822d580e", actual)
}
