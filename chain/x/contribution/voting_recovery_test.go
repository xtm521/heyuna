// SPDX-License-Identifier: Apache-2.0
package contribution

import (
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestTwoHonestVerifiersCancelMaliciousFirstVoteAndRepropose(t *testing.T) {
	f := newFixture(t)
	r := f.accepted(0, 0)
	malicious := ProposeEpoch{Epoch: 0, Entries: []Entry{{0, r.ID, 0, "2", r.Recipient}}}
	f.must(0, "propose_epoch", malicious)
	e, _ := f.k.Epoch(f.ctx, 0)
	require.Equal(t, "voting", e.Status)
	require.False(t, f.k.rawHashReserved(f.ctx, r.ResultHash))
	require.Equal(t, "0", f.k.Accounting(f.ctx).TrainingReserved)
	_, err := f.exec(1, "propose_epoch", ProposeEpoch{Epoch: 0, Entries: []Entry{{0, r.ID, 0, "1", r.Recipient}}})
	require.ErrorContains(t, err, "cannot be overwritten")
	f.must(1, "cancel_epoch", ControlEpoch{0, 0})
	require.NoError(t, f.k.CheckInvariants(f.ctx))
	f.must(2, "cancel_epoch", ControlEpoch{0, 0})
	e, _ = f.k.Epoch(f.ctx, 0)
	require.Equal(t, "cancelled", e.Status)
	require.EqualValues(t, 1, e.ControlNonce)
	require.Equal(t, "0", f.k.Accounting(f.ctx).TrainingReserved)
	require.False(t, f.k.rawHashReserved(f.ctx, r.ResultHash))
	require.NoError(t, f.k.CheckInvariants(f.ctx))
	honest := ProposeEpoch{Epoch: 0, Nonce: 1, Entries: []Entry{{0, r.ID, 0, "1", r.Recipient}}}
	f.must(1, "propose_epoch", honest)
	f.must(2, "propose_epoch", honest)
	e, _ = f.k.Epoch(f.ctx, 0)
	require.Equal(t, "pending", e.Status)
	f.ctx = f.ctx.WithBlockTime(time.Unix(e.FinalizeAfter, 0))
	f.must(3, "finalize_epoch", EpochRef{0})
	require.NoError(t, f.k.CheckInvariants(f.ctx))
}

func TestProposalQuorumInvalidatesAnEarlierVotingCancelVote(t *testing.T) {
	f := newFixture(t)
	r := f.accepted(0, 0)
	p := ProposeEpoch{Epoch: 0, Entries: []Entry{{0, r.ID, 0, "1", r.Recipient}}}
	f.must(0, "propose_epoch", p)
	f.must(1, "cancel_epoch", ControlEpoch{0, 0})
	f.must(2, "propose_epoch", p)
	e, _ := f.k.Epoch(f.ctx, 0)
	require.Equal(t, "pending", e.Status)
	require.Empty(t, e.ControlVotes)
	require.EqualValues(t, 1, e.ControlNonce)
	require.NoError(t, f.k.CheckInvariants(f.ctx))
	_, err := f.exec(1, "cancel_epoch", ControlEpoch{0, 0})
	require.ErrorContains(t, err, "stale")
}
