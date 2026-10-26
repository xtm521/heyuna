// SPDX-License-Identifier: Apache-2.0
package contribution

import (
	"bytes"
	"encoding/json"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/cosmos/cosmos-sdk/codec"
	addresscodec "github.com/cosmos/cosmos-sdk/codec/address"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	"github.com/cosmos/cosmos-sdk/testutil"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/x/tx/signing"
	"github.com/cosmos/gogoproto/proto"
	"github.com/ethereum/go-ethereum/common"
	"github.com/stretchr/testify/require"
)

type fixture struct {
	t      *testing.T
	ctx    sdk.Context
	k      Keeper
	c      Config
	actors []string
	keys   []string
}

func testHash(b byte) string { return "0x" + strings.Repeat(string("0123456789abcdef"[b%16]), 64) }
func newFixture(t *testing.T) *fixture {
	key := storetypes.NewKVStoreKey(ModuleName)
	ctx := testutil.DefaultContext(key, storetypes.NewTransientStoreKey("transient_contribution")).WithChainID("heyuna_297011-1").WithBlockTime(time.Unix(1_800_000_000, 0))
	actors := []string{}
	keys := []string{}
	for i := byte(1); i <= 5; i++ {
		raw := bytes.Repeat([]byte{i}, 20)
		actors = append(actors, sdk.AccAddress(raw).String())
		keys = append(keys, strings.ToLower(common.BytesToAddress(raw).Hex()))
	}
	c := Config{Version: 1, ChainID: ctx.ChainID(), EVMChainID: 297011, NetworkDomain: testHash(9), VaultAddress: "0x0000000000000000000000000000000000001000", Verifiers: keys[:3], StartTime: ctx.BlockTime().Unix(), ChallengeSeconds: ChallengePeriodSeconds}
	k := NewKeeper(key)
	require.NoError(t, k.InitGenesis(ctx, GenesisState{Config: c}))
	return &fixture{t, ctx, k, c, actors, keys}
}
func (f *fixture) payload(kind string, body any) []byte {
	b, err := json.Marshal(body)
	require.NoError(f.t, err)
	b, err = json.Marshal(Envelope{1, f.c.ChainID, f.c.NetworkDomain, f.c.VaultAddress, kind, b})
	require.NoError(f.t, err)
	return b
}
func (f *fixture) exec(actor int, kind string, body any) (string, error) {
	ctx, commit := f.ctx.CacheContext()
	id, err := f.k.Execute(ctx, f.actors[actor], f.payload(kind, body))
	if err == nil {
		commit()
	}
	return id, err
}
func (f *fixture) must(actor int, kind string, body any) string {
	id, err := f.exec(actor, kind, body)
	require.NoError(f.t, err)
	return id
}
func (f *fixture) accepted(n uint64, category uint8) Receipt {
	tid := f.must(3, "submit_task", SubmitTask{testHash(1), testHash(2), testHash(3), testHash(4), n, f.keys[3], category, n, ""})
	rid := f.must(3, "submit_result", SubmitResult{TaskID: tid, ResultHash: testHash(byte(5 + n))})
	f.must(0, "submit_report", SubmitReport{rid, testHash(10), true})
	f.must(1, "submit_report", SubmitReport{rid, testHash(11), true})
	r, err := f.k.Receipt(f.ctx, rid)
	require.NoError(f.t, err)
	return r
}
func (f *fixture) pending(r Receipt) Epoch {
	e := Entry{0, r.ID, r.Category, "1000000000000000000", r.Recipient}
	v := ProposeEpoch{Epoch: 0, Entries: []Entry{e}}
	f.must(0, "propose_epoch", v)
	f.must(1, "propose_epoch", v)
	epoch, err := f.k.Epoch(f.ctx, 0)
	require.NoError(f.t, err)
	return epoch
}

func TestSDKStateContributionFlowAndChallenge(t *testing.T) {
	f := newFixture(t)
	r := f.accepted(0, 0)
	e := f.pending(r)
	require.Equal(t, "pending", e.Status)
	require.Equal(t, f.c.StartTime+ChallengePeriodSeconds, e.FinalizeAfter)
	_, err := f.exec(3, "finalize_epoch", EpochRef{0})
	require.ErrorContains(t, err, "challenge period")
	cid := f.must(4, "challenge", ChallengeInput{0, testHash(12)})
	ch, err := f.k.Challenge(f.ctx, cid)
	require.NoError(t, err)
	require.Equal(t, f.keys[4], ch.Challenger)
	e, _ = f.k.Epoch(f.ctx, 0)
	require.Equal(t, "pending", e.Status, "public challenge must not enable free freezing")
	_, err = f.exec(4, "freeze_epoch", ControlEpoch{0, e.ControlNonce})
	require.Error(t, err)
	f.must(2, "freeze_epoch", ControlEpoch{0, 1})
	e, _ = f.k.Epoch(f.ctx, 0)
	require.Equal(t, "frozen", e.Status)
	require.EqualValues(t, 2, e.ControlNonce)
	f.ctx = f.ctx.WithBlockTime(time.Unix(e.FinalizeAfter+1, 0))
	_, err = f.exec(4, "finalize_epoch", EpochRef{0})
	require.Error(t, err)
	f.must(0, "resume_epoch", ControlEpoch{0, 2})
	e, _ = f.k.Epoch(f.ctx, 0)
	require.Equal(t, "frozen", e.Status)
	f.must(1, "resume_epoch", ControlEpoch{0, 2})
	e, _ = f.k.Epoch(f.ctx, 0)
	require.Equal(t, "pending", e.Status)
	require.Equal(t, f.ctx.BlockTime().Unix()+ChallengePeriodSeconds, e.FinalizeAfter)
	_, err = f.exec(0, "resume_epoch", ControlEpoch{0, 2})
	require.ErrorContains(t, err, "stale control nonce")
	f.ctx = f.ctx.WithBlockTime(time.Unix(e.FinalizeAfter-1, 0))
	_, err = f.exec(4, "finalize_epoch", EpochRef{0})
	require.Error(t, err)
	f.ctx = f.ctx.WithBlockTime(time.Unix(e.FinalizeAfter, 0))
	f.must(4, "finalize_epoch", EpochRef{0})
	e, _ = f.k.Epoch(f.ctx, 0)
	require.Equal(t, "finalized", e.Status)
	_, err = f.exec(2, "freeze_epoch", ControlEpoch{0, e.ControlNonce})
	require.Error(t, err)
	_, err = f.exec(4, "finalize_epoch", EpochRef{0})
	require.Error(t, err)
	_, err = f.exec(0, "propose_epoch", ProposeEpoch{Epoch: 0, Entries: e.Entries})
	require.ErrorContains(t, err, "cannot be overwritten")
	require.NoError(t, f.k.CheckInvariants(f.ctx))
}

func TestReceiptBindingDedupAndIndependentReports(t *testing.T) {
	f := newFixture(t)
	task := SubmitTask{testHash(1), testHash(2), testHash(3), testHash(4), 1, f.keys[0], 0, 3, ""}
	id := f.must(0, "submit_task", task)
	_, err := f.exec(0, "submit_task", task)
	require.ErrorContains(t, err, "duplicate task")
	_, err = f.exec(1, "submit_result", SubmitResult{TaskID: id, ResultHash: testHash(5)})
	require.ErrorContains(t, err, "signer")
	rid := f.must(0, "submit_result", SubmitResult{TaskID: id, ResultHash: testHash(5)})
	_, err = f.exec(0, "submit_report", SubmitReport{rid, testHash(10), true})
	require.ErrorContains(t, err, "self-verification")
	_, err = f.exec(4, "submit_report", SubmitReport{rid, testHash(10), true})
	require.ErrorContains(t, err, "invited")
	f.must(1, "submit_report", SubmitReport{rid, testHash(10), true})
	_, err = f.exec(1, "submit_report", SubmitReport{rid, testHash(11), true})
	require.ErrorContains(t, err, "already reported")
	entry := Entry{0, rid, 0, "1", f.keys[0]}
	_, err = f.exec(1, "propose_epoch", ProposeEpoch{Epoch: 0, Entries: []Entry{entry}})
	require.ErrorContains(t, err, "lacks two")
	f.must(2, "submit_report", SubmitReport{rid, testHash(12), true})
	task.Nonce++
	newID := f.must(0, "submit_task", task)
	_, err = f.exec(0, "submit_result", SubmitResult{TaskID: newID, ResultHash: testHash(5)})
	require.NoError(t, err, "unaudited copies cannot reserve a raw hash")
	task.Round++
	roundID := f.must(0, "submit_task", task)
	require.NotEqual(t, id, roundID)
	entry.Recipient = f.keys[4]
	_, err = f.exec(0, "propose_epoch", ProposeEpoch{Epoch: 0, Entries: []Entry{entry}})
	require.ErrorContains(t, err, "mismatched")
}

func TestBudgetCapsQuorumAndCurrentWeekPolicy(t *testing.T) {
	f := newFixture(t)
	r := f.accepted(0, 0)
	max, _ := WeeklyBudget(0)
	entry := Entry{0, r.ID, 0, new(big.Int).Add(max, big.NewInt(1)).String(), r.Recipient}
	_, err := f.exec(0, "propose_epoch", ProposeEpoch{Epoch: 0, Entries: []Entry{entry}})
	require.ErrorContains(t, err, "weekly")
	entry.Amount = "1"
	_, err = f.exec(0, "propose_epoch", ProposeEpoch{Epoch: 1, Entries: []Entry{entry}})
	require.ErrorContains(t, err, "current release week")
	entry.Index = 1
	_, err = f.exec(0, "propose_epoch", ProposeEpoch{Epoch: 0, Entries: []Entry{entry}})
	require.ErrorContains(t, err, "indices")
	entry.Index = 0
	f.k.put(f.ctx, "accounting", Accounting{TrainingCap().String(), "0"})
	_, err = f.exec(0, "propose_epoch", ProposeEpoch{Epoch: 0, Entries: []Entry{entry}})
	require.ErrorContains(t, err, "cumulative")
	f.k.put(f.ctx, "accounting", Accounting{"0", "0"})
	v := ProposeEpoch{Epoch: 0, Entries: []Entry{entry}}
	f.must(0, "propose_epoch", v)
	a := f.k.Accounting(f.ctx)
	require.Equal(t, "0", a.TrainingReserved, "one vote must not reserve funds")
	_, err = f.exec(0, "propose_epoch", v)
	require.ErrorContains(t, err, "duplicate epoch")
	changed := v
	changed.Entries = append([]Entry(nil), v.Entries...)
	changed.Entries[0].Amount = "2"
	_, err = f.exec(1, "propose_epoch", changed)
	require.ErrorContains(t, err, "overwritten")
	f.must(1, "propose_epoch", v)
	a = f.k.Accounting(f.ctx)
	require.Equal(t, "1", a.TrainingReserved)
	f.ctx = f.ctx.WithBlockTime(time.Unix(f.c.StartTime+WeekSeconds, 0))
	_, err = f.exec(0, "propose_epoch", v)
	require.ErrorContains(t, err, "current release week")
	// Finalization is deliberately allowed after the proposal week closes.
	f.must(4, "finalize_epoch", EpochRef{0})
	require.NoError(t, f.k.CheckInvariants(f.ctx))
}

func TestCancelReleasesReservationAndRequiresFreshNonce(t *testing.T) {
	f := newFixture(t)
	r := f.accepted(0, 0)
	e := f.pending(r)
	f.must(2, "freeze_epoch", ControlEpoch{0, e.ControlNonce})
	f.must(0, "cancel_epoch", ControlEpoch{0, 2})
	_, err := f.exec(0, "resume_epoch", ControlEpoch{0, 2})
	require.ErrorContains(t, err, "conflicting")
	f.must(1, "cancel_epoch", ControlEpoch{0, 2})
	e, _ = f.k.Epoch(f.ctx, 0)
	require.Equal(t, "cancelled", e.Status)
	require.EqualValues(t, 3, e.ControlNonce)
	r, _ = f.k.Receipt(f.ctx, r.ID)
	require.False(t, r.Allocated)
	require.Equal(t, "0", f.k.Accounting(f.ctx).TrainingReserved)
	v := ProposeEpoch{Epoch: 0, Entries: e.Entries}
	_, err = f.exec(0, "propose_epoch", v)
	require.ErrorContains(t, err, "fresh epoch nonce")
	v.Nonce = e.ControlNonce
	f.must(0, "propose_epoch", v)
	f.must(1, "propose_epoch", v)
	e, _ = f.k.Epoch(f.ctx, 0)
	require.Equal(t, "pending", e.Status)
	require.EqualValues(t, 4, e.ControlNonce)
	_, err = f.exec(0, "resume_epoch", ControlEpoch{0, 2})
	require.ErrorContains(t, err, "stale")
	require.NoError(t, f.k.CheckInvariants(f.ctx))
}

func TestDomainSizeAndGenesisProfiles(t *testing.T) {
	f := newFixture(t)
	b := f.payload("finalize_epoch", EpochRef{0})
	var e Envelope
	require.NoError(t, json.Unmarshal(b, &e))
	e.ChainID = "heyuna_297012-1"
	bad, _ := json.Marshal(e)
	_, err := f.k.Execute(f.ctx, f.actors[0], bad)
	require.ErrorContains(t, err, "domain mismatch")
	e.ChainID = f.c.ChainID
	e.NetworkDomain = testHash(8)
	bad, _ = json.Marshal(e)
	_, err = f.k.Execute(f.ctx, f.actors[0], bad)
	require.ErrorContains(t, err, "domain mismatch")
	e.NetworkDomain = f.c.NetworkDomain
	e.VaultAddress = f.keys[4]
	bad, _ = json.Marshal(e)
	_, err = f.k.Execute(f.ctx, f.actors[0], bad)
	require.ErrorContains(t, err, "domain mismatch")
	_, err = f.k.Execute(f.ctx, f.actors[0], bytes.Repeat([]byte("x"), MaxPayloadBytes+1))
	require.Error(t, err)
	_, err = f.k.Execute(f.ctx, f.actors[0], append(b, []byte(" {}")...))
	require.ErrorContains(t, err, "trailing")
	_, err = f.k.Execute(f.ctx, "0x1234", b)
	require.ErrorContains(t, err, "authenticated")
	c := f.c
	c.ChallengeSeconds = 3
	require.Error(t, c.Validate())
	c.UnsafeTestProfile = true
	require.Error(t, c.Validate())
	c.ChainID = "heyuna_297012-1"
	c.EVMChainID = 297012
	require.NoError(t, c.Validate())
	c.Verifiers = []string{f.keys[0], f.keys[0], f.keys[2]}
	require.Error(t, c.Validate())
}

func TestSDKGenesisExportAndMerkleDomain(t *testing.T) {
	f := newFixture(t)
	r := f.accepted(0, 0)
	e := f.pending(r)
	gs := f.k.ExportGenesis(f.ctx)
	key := storetypes.NewKVStoreKey("restore")
	ctx := testutil.DefaultContext(key, storetypes.NewTransientStoreKey("restore_t")).WithChainID(f.c.ChainID).WithBlockTime(f.ctx.BlockTime())
	k := NewKeeper(key)
	require.NoError(t, k.InitGenesis(ctx, gs))
	require.Equal(t, gs, k.ExportGenesis(ctx))
	require.NoError(t, k.CheckInvariants(ctx))
	h, err := RewardRoot(f.c, 0, e.Entries)
	require.NoError(t, err)
	require.Equal(t, e.Root, h.Hex())
	c := f.c
	c.EVMChainID++
	h2, err := RewardRoot(c, 0, e.Entries)
	require.NoError(t, err)
	require.NotEqual(t, h, h2)
	c = f.c
	c.VaultAddress = f.keys[4]
	h2, _ = RewardRoot(c, 0, e.Entries)
	require.NotEqual(t, h, h2)
	h2, _ = RewardRoot(f.c, 1, e.Entries)
	require.NotEqual(t, h, h2)
	copyEntries := append([]Entry(nil), e.Entries...)
	copyEntries[0].Category = 1
	h2, _ = RewardRoot(f.c, 0, copyEntries)
	require.NotEqual(t, h, h2)
}

func TestReleaseDifferenceAndCanonicalAmounts(t *testing.T) {
	total := new(big.Int)
	for i := uint64(0); i < ReleaseWeeks; i++ {
		a, b := WeeklyBudget(i)
		total.Add(total, a)
		total.Add(total, b)
	}
	require.Equal(t, TotalCap().String(), total.String())
	a, b := WeeklyBudget(ReleaseWeeks)
	require.LessOrEqual(t, new(big.Int).Add(a, b).Cmp(new(big.Int).Div(new(big.Int).Add(TotalCap(), big.NewInt(519)), big.NewInt(520))), 0)
	for _, bad := range []string{"-1", "01", "+1", "1.0", "1e18", "", "0x12", strings.Repeat("9", 79)} {
		_, err := amount(bad)
		require.Error(t, err)
	}
}

func TestSDKSignerDescriptorAndWireRoundTrip(t *testing.T) {
	f := newFixture(t)
	r, err := codectypes.NewInterfaceRegistryWithOptions(codectypes.InterfaceRegistryOptions{ProtoFiles: proto.HybridResolver, SigningOptions: signing.Options{AddressCodec: addresscodec.NewBech32Codec("cosmos"), ValidatorAddressCodec: addresscodec.NewBech32Codec("cosmosvaloper")}})
	require.NoError(t, err)
	AppModule{}.RegisterInterfaces(r)
	cdc := codec.NewProtoCodec(r)
	msg := &MsgExecute{Sender: f.actors[3], Payload: f.payload("finalize_epoch", EpochRef{0})}
	signers, _, err := cdc.GetMsgV1Signers(msg)
	require.NoError(t, err)
	require.Equal(t, common.HexToAddress(f.keys[3]).Bytes(), signers[0])
	require.Equal(t, "/heyuna.contribution.v1.MsgExecute", sdk.MsgTypeURL(msg))
	b, err := cdc.Marshal(msg)
	require.NoError(t, err)
	var decoded MsgExecute
	require.NoError(t, cdc.Unmarshal(b, &decoded))
	require.Equal(t, msg.Sender, decoded.Sender)
	require.Equal(t, msg.Payload, decoded.Payload)
}

func TestRestoreRejectsForgedBudgetWithoutPartialState(t *testing.T) {
	f := newFixture(t)
	r := f.accepted(0, 0)
	f.pending(r)
	gs := f.k.ExportGenesis(f.ctx)
	for i, record := range gs.Records {
		if strings.HasPrefix(record.Key, "epoch/") {
			var epoch Epoch
			require.NoError(t, json.Unmarshal(record.Value, &epoch))
			epoch.TrainingBudget = "0"
			encoded, err := json.Marshal(epoch)
			require.NoError(t, err)
			gs.Records[i].Value = encoded
		}
	}
	key := storetypes.NewKVStoreKey("corrupt_restore")
	ctx := testutil.DefaultContext(key, storetypes.NewTransientStoreKey("corrupt_restore_t")).WithChainID(f.c.ChainID).WithBlockTime(f.ctx.BlockTime())
	k := NewKeeper(key)
	require.ErrorContains(t, k.InitGenesis(ctx, gs), "budget invariant")
	_, err := k.Config(ctx)
	require.ErrorContains(t, err, "not initialized")
}

func TestAcceleratedProfileKeepsIndependentThreeSecondDeadline(t *testing.T) {
	f := newFixture(t)
	key := storetypes.NewKVStoreKey("accelerated")
	ctx := testutil.DefaultContext(key, storetypes.NewTransientStoreKey("accelerated_t")).WithChainID("heyuna_297012-1").WithBlockTime(f.ctx.BlockTime())
	f.ctx = ctx
	f.k = NewKeeper(key)
	f.c.ChainID = ctx.ChainID()
	f.c.EVMChainID = 297012
	f.c.ChallengeSeconds = 3
	f.c.UnsafeTestProfile = true
	f.c.NetworkDomain = testHash(13)
	require.NoError(t, f.k.InitGenesis(ctx, GenesisState{Config: f.c}))
	r := f.accepted(0, 0)
	e := f.pending(r)
	require.Equal(t, int64(3), e.FinalizeAfter-e.ProposedAt)
	f.ctx = f.ctx.WithBlockTime(time.Unix(e.FinalizeAfter-1, 0))
	_, err := f.exec(4, "finalize_epoch", EpochRef{0})
	require.Error(t, err)
	f.ctx = f.ctx.WithBlockTime(time.Unix(e.FinalizeAfter, 0))
	f.must(4, "finalize_epoch", EpochRef{0})
	require.NoError(t, f.k.CheckInvariants(f.ctx))
}
